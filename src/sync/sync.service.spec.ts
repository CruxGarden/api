import { randomUUID } from 'node:crypto';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SyncService } from './sync.service';
import type { SyncHead, SyncUpload } from './sync.repository';

/** HTTP result and error contracts; atomic ownership is tested on actual PostgreSQL. */
describe('SyncService', () => {
  const account = randomUUID(),
    crux = randomUUID();
  let service: SyncService;
  let heads: Map<string, SyncHead>;
  let uploads: Map<string, SyncUpload>;
  let objects: Map<string, Buffer>;
  let author: { findByAccountId: jest.Mock };
  let usage: {
    recordSyncObject: jest.Mock;
    clearSyncObject: jest.Mock;
    recordTransfer: jest.Mock;
  };
  let store: { download: jest.Mock; upload: jest.Mock; delete: jest.Mock };
  let notifications: { afterWrite: jest.Mock };
  let logger: { createChildLogger: jest.Mock; error: jest.Mock };
  beforeEach(() => {
    heads = new Map();
    uploads = new Map();
    objects = new Map();
    const ok = (data?: unknown) =>
      Promise.resolve({ data: data ?? null, error: null });
    let admitted = false;
    const repo = {
      forAccount: async (_account: string, work: () => Promise<unknown>) =>
        work(),
      closing: () => ok(false),
      admitted: () => ok(admitted),
      admit: (_account: string, initial: SyncHead[]) => {
        admitted = true;
        for (const head of initial) heads.set(head.object_id, head);
        return ok();
      },
      heads: () => ok([...heads.values()]),
      head: (_account: string, _kind: string, id: string) => ok(heads.get(id)),
      save: (head: SyncHead) => {
        heads.set(head.object_id, head);
        return ok();
      },
      uploads: () => ok([...uploads.values()]),
      stage: (upload: SyncUpload) => {
        uploads.set(upload.revision_id, { ...upload });
        return ok();
      },
      setUploadState: (id: string, state: SyncUpload['state']) => {
        uploads.get(id)!.state = state;
        return ok();
      },
      forgetUpload: (id: string) => {
        uploads.delete(id);
        return ok();
      },
    };
    store = {
      download: jest.fn(async ({ path }) => {
        if (!objects.has(path))
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return { data: objects.get(path)! };
      }),
      upload: jest.fn(async ({ path, data }) => {
        objects.set(path, data);
      }),
      delete: jest.fn(async ({ path }) => {
        objects.delete(path);
      }),
    };
    usage = {
      recordSyncObject: jest.fn(),
      clearSyncObject: jest.fn(),
      recordTransfer: jest.fn(),
    };
    author = { findByAccountId: jest.fn(async () => ({ id: randomUUID() })) };
    notifications = { afterWrite: jest.fn() };
    logger = { createChildLogger: jest.fn(), error: jest.fn() };
    logger.createChildLogger.mockReturnValue(logger);
    service = new SyncService(
      store as never,
      logger as never,
      usage as never,
      { assertStorage: jest.fn() } as never,
      author as never,
      notifications as never,
      repo as never,
    );
  });
  const seed = (kind: 'garden' | 'crux', data: Buffer) => {
    const time = '2026-09-30T00:00:00.000Z';
    if (kind === 'garden') {
      objects.set(`sync/${account}/garden.zip`, data);
      objects.set(
        `sync/${account}/garden-meta.json`,
        Buffer.from(JSON.stringify({ syncedAt: time, size: data.length })),
      );
    } else {
      objects.set(`sync/${account}/cruxes/${crux}.crux`, data);
      objects.set(
        `sync/${account}/cruxes/_index.json`,
        Buffer.from(
          JSON.stringify([
            {
              cruxId: crux,
              slug: 'existing',
              title: 'Existing',
              updatedAt: time,
              size: data.length,
            },
          ]),
        ),
      );
    }
  };
  it('uploads a Garden once and reports durable metadata and usage', async () => {
    const data = Buffer.from('garden');
    expect(await service.pushGarden(account, data)).toEqual({
      syncedAt: expect.any(String),
      size: data.length,
    });
    expect(store.upload).toHaveBeenCalledTimes(1);
    expect(store.upload).toHaveBeenCalledWith(
      expect.objectContaining({ data, contentType: 'application/zip' }),
    );
    expect(usage.recordSyncObject).toHaveBeenCalledWith(
      account,
      'garden',
      'garden',
      data.length,
      'Garden backup',
    );
    expect(usage.recordTransfer).toHaveBeenCalledWith(account, data.length, 0);
  });
  it('pulls a Garden backup and records transfer', async () => {
    const data = Buffer.from('garden');
    seed('garden', data);
    expect(await service.pullGarden(account)).toEqual(data);
    expect(usage.recordTransfer).toHaveBeenCalledWith(account, 0, data.length);
  });
  it('reports Garden metadata and absence', async () => {
    expect(await service.getGardenStatus(account)).toBeNull();
    await service.pushGarden(account, Buffer.from('new'));
    expect(await service.getGardenStatus(account)).toEqual({
      syncedAt: expect.any(String),
      size: 3,
    });
  });
  it('deletes a Garden backup and clears its usage', async () => {
    seed('garden', Buffer.from('old'));
    await service.deleteGarden(account);
    expect(await service.getGardenStatus(account)).toBeNull();
    expect(usage.clearSyncObject).toHaveBeenCalledWith(
      account,
      'garden',
      'garden',
    );
    expect(objects.has(`sync/${account}/garden.zip`)).toBe(false);
  });
  it('uploads and lists Crux metadata', async () => {
    const data = Buffer.from('crux');
    const entry = await service.pushCrux(account, crux, data, {
      slug: 'new',
      title: 'New',
    });
    expect(entry).toEqual({
      cruxId: crux,
      slug: 'new',
      title: 'New',
      updatedAt: expect.any(String),
      size: 4,
    });
    expect(await service.listCruxes(account)).toEqual([entry]);
  });
  it('replaces an existing Crux without duplicating the listing', async () => {
    seed('crux', Buffer.from('old'));
    await service.pushCrux(account, crux, Buffer.from('new'), {
      slug: 'changed',
      title: 'Changed',
    });
    expect(await service.listCruxes(account)).toEqual([
      expect.objectContaining({ slug: 'changed', title: 'Changed' }),
    ]);
    expect(await service.pullCrux(account, crux)).toEqual(Buffer.from('new'));
  });
  it('pulls current-format Crux bytes unchanged', async () => {
    const data = Buffer.from('crux');
    seed('crux', data);
    expect(await service.pullCrux(account, crux)).toEqual(data);
  });
  it('returns the current-format listing unchanged', async () => {
    seed('crux', Buffer.from('crux'));
    expect(await service.listCruxes(account)).toEqual([
      {
        cruxId: crux,
        slug: 'existing',
        title: 'Existing',
        updatedAt: '2026-09-30T00:00:00.000Z',
        size: 4,
      },
    ]);
  });
  it('returns an empty listing only for explicit absence', async () => {
    expect(await service.listCruxes(account)).toEqual([]);
  });
  it.each(['garden', 'crux'] as const)(
    'returns 404 for an absent %s backup',
    async (kind) => {
      await expect(
        kind === 'garden'
          ? service.pullGarden(account)
          : service.pullCrux(account, crux),
      ).rejects.toThrow(NotFoundException);
    },
  );
  it('deletes one Crux while preserving another', async () => {
    seed('crux', Buffer.from('old'));
    const other = randomUUID();
    await service.pushCrux(account, other, Buffer.from('other'), {
      slug: 'other',
      title: 'Other',
    });
    await service.deleteCrux(account, crux);
    expect(await service.listCruxes(account)).toEqual([
      expect.objectContaining({ cruxId: other }),
    ]);
    expect(usage.clearSyncObject).toHaveBeenCalledWith(account, 'crux', crux);
  });
  it('does not bypass quota checks when author lookup fails', async () => {
    author.findByAccountId.mockRejectedValue(
      new ServiceUnavailableException('author unavailable'),
    );
    await expect(
      service.pushGarden(account, Buffer.from('new')),
    ).rejects.toThrow('author unavailable');
    expect(store.upload).not.toHaveBeenCalled();
  });
  it('isolates a post-commit notification refusal', async () => {
    notifications.afterWrite.mockRejectedValue(new Error('mail unavailable'));
    await service.pushGarden(account, Buffer.from('new'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      'Sync committed; usage notification failed',
      expect.any(Error),
    );
    expect(await service.pullGarden(account)).toEqual(Buffer.from('new'));
  });
});
