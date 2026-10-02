import { SyncUploadRecovery } from '../src/sync/sync-upload-recovery';
import { SyncAccountCleanup } from '../src/sync/sync-account-cleanup';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { postgresFixture } from './support/postgres';
import { SyncService } from '../src/sync/sync.service';
import { SyncRepository } from '../src/sync/sync.repository';
import { StoreService } from '../src/common/services/store.service';
import { LoggerService } from '../src/common/services/logger.service';
import { UsageRepository } from '../src/usage/usage.repository';
import { UsageService } from '../src/usage/usage.service';
import { LimitsService } from '../src/usage/limits.service';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Real PostgreSQL locks/transactions and real disk bytes, across two service owners. */
describe('Sync backup ownership and recovery', () => {
  const env = { ...process.env };
  const account = randomUUID(),
    otherAccount = randomUUID(),
    home = randomUUID(),
    authorId = randomUUID();
  const logger = new LoggerService();
  const namespace = 'sync-fixture';
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let root: string;
  let directory: string;
  let store: StoreService;
  let repo: SyncRepository;
  let usageRepo: UsageRepository;
  let usage: UsageService;
  let owner: SyncService;
  let peer: SyncService;
  const makeOwner = () =>
    new SyncService(
      store,
      logger,
      usage,
      new LimitsService(usage, { planIdFor: async () => 'free' } as never),
      { findByAccountId: async () => ({ id: authorId }) } as never,
      { afterWrite: async () => undefined } as never,
      new SyncRepository(fixture.db, logger),
    );
  const push = (service: SyncService, id: string, bytes: string) =>
    service.pushCrux(account, id, Buffer.from(bytes), {
      slug: id,
      title: bytes,
    });
  const put = (path: string, data: string) =>
    store.upload({
      namespace,
      path: `sync/${account}/${path}`,
      data: Buffer.from(data),
    });
  const query = () => fixture.db.query();
  beforeAll(async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_S3_SYNC_BUCKET = namespace;
    root = await fs.mkdtemp(join(tmpdir(), 'crux-sync-owned-'));
    fixture = await postgresFixture();
    await query()('homes').insert({
      id: home,
      name: 'Sync fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await query()('accounts').insert([
      {
        id: account,
        home_id: home,
        email: 'sync@example.test',
        role: 'author',
      },
      {
        id: otherAccount,
        home_id: home,
        email: 'other-sync@example.test',
        role: 'author',
      },
    ]);
    await query()('authors').insert({
      id: authorId,
      account_id: account,
      home_id: home,
      username: 'sync-fixture',
      display_name: 'Sync Fixture',
    });
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      'sync_recoveries',
      'sync_uploads',
      'sync_heads',
      'sync_account_state',
      'usage_sync_objects',
      'usage_sync_daily',
      'billing_account_state',
    ])
      await query()(table).delete();
    directory = await fs.mkdtemp(join(root, 'case-'));
    process.env.LOCAL_STORE_DIR = directory;
    store = new StoreService(logger);
    repo = new SyncRepository(fixture.db, logger);
    usageRepo = new UsageRepository(fixture.db, logger);
    usage = new UsageService(usageRepo, logger);
    owner = makeOwner();
    peer = makeOwner();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    process.env = { ...env };
    await fixture?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('retains two competing Cruxes, exact bytes and usage across restart; scopes another account', async () => {
    const first = randomUUID(),
      second = randomUUID();
    const entered = latch(),
      release = latch();
    let count = 0;
    const upload = store.upload.bind(store);
    jest.spyOn(store, 'upload').mockImplementation(async (options) => {
      if (++count === 2) entered.release();
      await release.promise;
      await upload(options);
    });
    const writes = Promise.all([
      push(owner, first, 'first bytes'),
      push(peer, second, 'second bytes'),
    ]);
    await entered.promise;
    release.release();
    await writes;
    const restarted = makeOwner();
    expect(
      (await restarted.listCruxes(account)).map((entry) => entry.cruxId).sort(),
    ).toEqual([first, second].sort());
    expect(await restarted.pullCrux(account, first)).toEqual(
      Buffer.from('first bytes'),
    );
    expect(await restarted.pullCrux(account, second)).toEqual(
      Buffer.from('second bytes'),
    );
    expect(await restarted.listCruxes(otherAccount)).toEqual([]);
    const stored = await query()('usage_sync_objects').where({
      account_id: account,
    });
    expect(stored.reduce((sum, row) => sum + Number(row.bytes), 0)).toBe(23);
  });

  it('refuses an older same-Crux upload without replacing the newer committed bytes', async () => {
    const id = randomUUID();
    await push(owner, id, 'original');
    const entered = latch(),
      release = latch();
    const upload = store.upload.bind(store);
    jest.spyOn(store, 'upload').mockImplementation(async (options) => {
      if (options.data!.toString() === 'slow') {
        entered.release();
        await release.promise;
      }
      await upload(options);
    });
    const slow = push(owner, id, 'slow');
    const refusal = expect(slow).rejects.toThrow(ConflictException);
    await entered.promise;
    await push(peer, id, 'newer');
    release.release();
    await refusal;
    expect(await makeOwner().pullCrux(account, id)).toEqual(
      Buffer.from('newer'),
    );
    expect((await repo.uploads(account)).data).toHaveLength(1);
  });

  it.each(['outage', 'corrupt', 'null', 'duplicate', 'unsafe-id'])(
    'preserves the catalog and bytes on %s admission refusal, then retries',
    async (failure) => {
      const id = randomUUID();
      const entry = {
        cruxId: id,
        slug: 'saved',
        title: 'Saved',
        size: 5,
        updatedAt: '2026-09-30T00:00:00Z',
      };
      const valid = JSON.stringify([entry]);
      await put(`cruxes/${id}.crux`, 'saved');
      const bytes =
        failure === 'null'
          ? 'null'
          : failure === 'corrupt'
            ? '{'
            : failure === 'duplicate'
              ? JSON.stringify([entry, entry])
              : failure === 'unsafe-id'
                ? JSON.stringify([{ ...entry, cruxId: '../outside' }])
                : valid;
      await put('cruxes/_index.json', bytes);
      if (failure === 'outage')
        jest
          .spyOn(store, 'download')
          .mockRejectedValueOnce(
            Object.assign(new Error('denied'), { name: 'AccessDenied' }),
          );
      await expect(push(owner, id, 'replacement')).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(await query()('sync_heads')).toEqual([]);
      expect(await query()('sync_account_state')).toEqual([]);
      expect(
        (
          await store.download({
            namespace,
            path: `sync/${account}/cruxes/${id}.crux`,
          })
        ).data.toString(),
      ).toBe('saved');
      expect(
        (
          await store.download({
            namespace,
            path: `sync/${account}/cruxes/_index.json`,
          })
        ).data.toString(),
      ).toBe(bytes);
      await put('cruxes/_index.json', valid);
      expect((await makeOwner().listCruxes(account))[0].cruxId).toBe(id);
      expect(await owner.pullCrux(account, id)).toEqual(Buffer.from('saved'));
    },
  );

  it('adopts current Garden metadata and bytes without rewriting them', async () => {
    const metadata = JSON.stringify({
      size: 6,
      syncedAt: '2026-09-30T00:00:00Z',
    });
    await put('garden.zip', 'garden');
    await put('garden-meta.json', metadata);
    expect(await owner.getGardenStatus(account)).toEqual({
      size: 6,
      syncedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(await makeOwner().pullGarden(account)).toEqual(
      Buffer.from('garden'),
    );
    expect(
      (
        await store.download({
          namespace,
          path: `sync/${account}/garden-meta.json`,
        })
      ).data.toString(),
    ).toBe(metadata);
  });

  it('rolls back activation when actual usage writes fail, preserves old bytes, and succeeds on retry', async () => {
    const id = randomUUID();
    await push(owner, id, 'old');
    await query().raw(
      `CREATE FUNCTION refuse_sync_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture refusal'; END $$`,
    );
    await query().raw(
      'CREATE TRIGGER refuse_sync_usage BEFORE UPDATE ON usage_sync_objects FOR EACH ROW EXECUTE FUNCTION refuse_sync_usage()',
    );
    try {
      await expect(push(owner, id, 'replacement')).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(await makeOwner().pullCrux(account, id)).toEqual(
        Buffer.from('old'),
      );
      expect(Number((await query()('usage_sync_objects').first()).bytes)).toBe(
        3,
      );
      expect(Number((await query()('usage_sync_daily').first()).uploads)).toBe(
        1,
      );
    } finally {
      await query().raw('DROP TRIGGER refuse_sync_usage ON usage_sync_objects');
      await query().raw('DROP FUNCTION refuse_sync_usage()');
    }
    await push(peer, id, 'retry');
    expect(await owner.pullCrux(account, id)).toEqual(Buffer.from('retry'));
  });

  it('checks a lost commit acknowledgement before cleanup and does not meter twice', async () => {
    const id = randomUUID();
    const repository = (owner as unknown as { repo: SyncRepository }).repo;
    const transaction = repository.forAccount.bind(repository);
    let transactions = 0;
    jest
      .spyOn(repository, 'forAccount')
      .mockImplementation(async (accountId, operation) => {
        const result = await transaction(accountId, operation);
        // cleanup transaction, staging transaction, activation transaction
        if (++transactions === 3) throw new Error('commit response lost');
        return result;
      });
    await push(owner, id, 'committed');
    expect(await peer.pullCrux(account, id)).toEqual(Buffer.from('committed'));
    expect(Number((await query()('usage_sync_daily').first()).uploads)).toBe(1);
  });

  it('retains a missing live head as an integrity refusal, never a misleading 404', async () => {
    const id = randomUUID();
    await push(owner, id, 'saved');
    const before = (await repo.head(account, 'crux', id)).data!;
    await store.delete({ namespace, path: before.storage_path! });
    await expect(peer.pullCrux(account, id)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect((await repo.head(account, 'crux', id)).data).toEqual(before);
    expect(await owner.listCruxes(account)).toHaveLength(1);
  });

  it('fences delete during a pending upload, refuses late activation, and finishes after restart', async () => {
    const id = randomUUID();
    await push(owner, id, 'old');
    const entered = latch(),
      release = latch();
    const upload = store.upload.bind(store);
    jest.spyOn(store, 'upload').mockImplementation(async (options) => {
      entered.release();
      await release.promise;
      await upload(options);
    });
    const pending = push(owner, id, 'late');
    const refusal = expect(pending).rejects.toThrow(ConflictException);
    await entered.promise;
    await expect(peer.deleteCrux(account, id)).rejects.toThrow(
      'waiting for a pending upload',
    );
    expect((await repo.head(account, 'crux', id)).data?.status).toBe(
      'deleting',
    );
    release.release();
    await refusal;
    await makeOwner().deleteCrux(account, id);
    expect(await peer.listCruxes(account)).toEqual([]);
    expect(await query()('usage_sync_objects')).toEqual([]);
    expect(await query()('sync_uploads')).toEqual([]);
  });

  it('keeps a deletion fence and usage on storage refusal and lets retry complete', async () => {
    const id = randomUUID();
    await push(owner, id, 'saved');
    jest
      .spyOn(store, 'delete')
      .mockRejectedValueOnce(new Error('storage refused'));
    await expect(owner.deleteCrux(account, id)).rejects.toThrow(
      'storage refused',
    );
    expect((await repo.head(account, 'crux', id)).data?.status).toBe(
      'deleting',
    );
    expect(await query()('usage_sync_objects')).toHaveLength(1);
    await expect(push(peer, id, 'replacement')).rejects.toThrow(
      'deletion is in progress',
    );
    await peer.deleteCrux(account, id);
    expect(await query()('usage_sync_objects')).toEqual([]);
    expect((await repo.head(account, 'crux', id)).data?.status).toBe('deleted');
  });

  it('bounds retained obsolete bytes after cleanup failure and retries without overwriting the head', async () => {
    const id = randomUUID();
    await push(owner, id, 'old');
    const deletion = jest
      .spyOn(store, 'delete')
      .mockRejectedValue(new Error('cleanup refused'));
    await push(peer, id, 'new');
    const before = (await repo.head(account, 'crux', id)).data;
    await expect(push(owner, id, 'another')).rejects.toThrow('cleanup refused');
    expect((await repo.head(account, 'crux', id)).data).toEqual(before);
    expect((await repo.uploads(account)).data).toHaveLength(2);
    deletion.mockRestore();
    await push(owner, id, 'retry');
    expect(await peer.pullCrux(account, id)).toEqual(Buffer.from('retry'));
    expect((await repo.uploads(account)).data).toHaveLength(1);
  });

  it('does not complete account cleanup while an admitted upload can still write', async () => {
    const id = randomUUID();
    const entered = latch(),
      release = latch();
    const upload = store.upload.bind(store);
    jest.spyOn(store, 'upload').mockImplementation(async (options) => {
      entered.release();
      await release.promise;
      await upload(options);
    });
    const pending = push(owner, id, 'late');
    const refusal = expect(pending).rejects.toThrow(
      'Account closure is in progress',
    );
    await entered.promise;
    await query()('billing_account_state').insert({
      account_id: account,
      closing_at: new Date(),
    });
    await expect(
      new SyncAccountCleanup(repo, store).closeAccount(account),
    ).rejects.toThrow('waiting for pending');
    release.release();
    await refusal;
    await new SyncAccountCleanup(
      new SyncRepository(fixture.db, logger),
      store,
    ).closeAccount(account);
    expect(await query()('sync_uploads')).toEqual([]);
    await expect(push(peer, randomUUID(), 'new')).rejects.toThrow(
      'Account closure is in progress',
    );
  });

  it('retains unknown upload outcomes visibly after restart and blocks cleanup instead of claiming success', async () => {
    const id = randomUUID();
    jest
      .spyOn(store, 'upload')
      .mockRejectedValueOnce(new Error('lost storage response'));
    await expect(push(owner, id, 'uncertain')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect((await repo.uploads(account)).data).toEqual([
      expect.objectContaining({ state: 'uploading', object_id: id }),
    ]);
    await expect(makeOwner().deleteCrux(account, id)).rejects.toThrow(
      'reconcile its intent',
    );
  });
  it('renewed deletion fences a pending upload admitted against a deleted tombstone', async () => {
    const id = randomUUID();
    await push(owner, id, 'old');
    await owner.deleteCrux(account, id);
    const entered = latch(),
      release = latch();
    const upload = store.upload.bind(store);
    jest.spyOn(store, 'upload').mockImplementation(async (options) => {
      entered.release();
      await release.promise;
      await upload(options);
    });
    const pending = push(owner, id, 'late');
    const refusal = expect(pending).rejects.toThrow(ConflictException);
    await entered.promise;
    await expect(peer.deleteCrux(account, id)).rejects.toThrow(
      'waiting for a pending upload',
    );
    release.release();
    await refusal;
    await makeOwner().deleteCrux(account, id);
    expect(await peer.listCruxes(account)).toEqual([]);
    expect(await query()('sync_uploads')).toEqual([]);
  });

  it('a duplicate remover does not forget an upload admitted after the first remover finalized', async () => {
    const id = randomUUID();
    await push(owner, id, 'old');
    const firstEntered = latch(),
      secondEntered = latch(),
      firstRelease = latch(),
      secondRelease = latch();
    const deletion = store.delete.bind(store);
    let calls = 0;
    jest.spyOn(store, 'delete').mockImplementation(async (options) => {
      if (++calls === 1) {
        firstEntered.release();
        await firstRelease.promise;
      } else if (calls === 2) {
        secondEntered.release();
        await secondRelease.promise;
      }
      await deletion(options);
    });
    const first = owner.deleteCrux(account, id);
    await firstEntered.promise;
    const second = peer.deleteCrux(account, id);
    await secondEntered.promise;
    firstRelease.release();
    await first;
    const uploadEntered = latch(),
      uploadRelease = latch();
    const upload = store.upload.bind(store);
    jest.spyOn(store, 'upload').mockImplementation(async (options) => {
      uploadEntered.release();
      await uploadRelease.promise;
      await upload(options);
    });
    const pending = push(owner, id, 'later');
    await uploadEntered.promise;
    secondRelease.release();
    await second;
    expect((await repo.uploads(account)).data).toEqual([
      expect.objectContaining({ state: 'uploading' }),
    ]);
    uploadRelease.release();
    await pending;
    expect(await peer.pullCrux(account, id)).toEqual(Buffer.from('later'));
  });
  it('retries a download once when replacement removes its captured revision', async () => {
    const id = randomUUID();
    await push(owner, id, 'old');
    const previous = (await repo.head(account, 'crux', id)).data!;
    const entered = latch(),
      release = latch();
    const download = store.download.bind(store);
    jest.spyOn(store, 'download').mockImplementation(async (options) => {
      if (options.path === previous.storage_path) {
        entered.release();
        await release.promise;
      }
      return download(options);
    });
    const reading = owner.pullCrux(account, id);
    await entered.promise;
    await push(peer, id, 'replacement');
    release.release();
    expect(await reading).toEqual(Buffer.from('replacement'));
  });

  it('requires writer drain proof for recovery, records an audit, preserves committed ownership and recovers failed cleanup', async () => {
    const id = randomUUID(),
      another = randomUUID();
    jest
      .spyOn(store, 'upload')
      .mockRejectedValueOnce(new Error('response lost'))
      .mockRejectedValueOnce(new Error('response lost'));
    await expect(push(owner, id, 'uncertain')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(push(peer, another, 'uncertain')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(push(owner, randomUUID(), 'more')).rejects.toThrow(
      'Two sync uploads are already pending',
    );
    const pending = (await repo.uploads(account)).data!;
    const recovery = new SyncUploadRecovery(repo, store);
    const first = pending.find((item) => item.object_id === id)!;
    await expect(
      recovery.retire(account, first.revision_id, {
        writerDrainConfirmed: false,
        reason: 'fixture writers drained',
      }),
    ).rejects.toThrow('Confirm all writers');
    expect(await query()('sync_recoveries')).toEqual([]);
    const deletion = jest
      .spyOn(store, 'delete')
      .mockRejectedValueOnce(new Error('cleanup unavailable'));
    await expect(
      recovery.retire(account, first.revision_id, {
        writerDrainConfirmed: true,
        reason: 'fixture writers drained',
      }),
    ).rejects.toThrow('cleanup unavailable');
    expect(
      (await recovery.inspect(account, first.revision_id)).upload.state,
    ).toBe('retired');
    expect(await query()('sync_recoveries')).toEqual([
      expect.objectContaining({
        revision_id: first.revision_id,
        reason: 'fixture writers drained',
      }),
    ]);
    deletion.mockRestore();
    await new SyncUploadRecovery(
      new SyncRepository(fixture.db, logger),
      store,
    ).retire(account, first.revision_id, {
      writerDrainConfirmed: true,
      reason: 'fixture cleanup retry',
    });
    await recovery.retire(
      account,
      pending.find((item) => item.object_id === another)!.revision_id,
      { writerDrainConfirmed: true, reason: 'fixture writers drained' },
    );
    await push(owner, id, 'saved');
    const committed = (await repo.head(account, 'crux', id)).data!;
    await expect(
      recovery.retire(account, committed.revision_id, {
        writerDrainConfirmed: true,
        reason: 'must not remove active bytes',
      }),
    ).rejects.toThrow('cannot be retired');
    expect(await peer.pullCrux(account, id)).toEqual(Buffer.from('saved'));
    expect(await query()('sync_recoveries')).toHaveLength(2);
    expect((await repo.uploads(account)).data).toHaveLength(1);
  });
});
