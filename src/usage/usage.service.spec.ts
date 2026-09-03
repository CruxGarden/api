import { UsageService } from './usage.service';
import { gzipSync } from 'node:zlib';

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
} as never;
const CRUX = '550e8400-e29b-41d4-a716-446655440000';

function fakeRepo() {
  const storage = new Map<
    string,
    {
      crux_id: string;
      author_id: string;
      bytes: number;
      files: number;
      updated: Date;
    }
  >();
  const daily = new Map<
    string,
    {
      author_id: string;
      crux_id: string;
      day: string;
      bytes: number;
      requests: number;
    }
  >();
  const ingested = new Set<string>();
  const syncObjects = new Map<
    string,
    {
      account_id: string;
      kind: 'garden' | 'crux';
      object_id: string;
      bytes: number;
      title: string | null;
      updated: Date;
    }
  >();
  const syncDaily = new Map<
    string,
    {
      account_id: string;
      day: string;
      bytes_up: number;
      bytes_down: number;
      uploads: number;
      downloads: number;
    }
  >();
  const ok = <T>(data: T) => Promise.resolve({ data, error: null });
  return {
    storage,
    daily,
    upsertSyncObject: jest.fn(
      (
        a: string,
        kind: 'garden' | 'crux',
        id: string,
        bytes: number,
        title: string | null,
      ) => {
        syncObjects.set(`${a}|${kind}|${id}`, {
          account_id: a,
          kind,
          object_id: id,
          bytes,
          title,
          updated: new Date('2026-09-03T10:00:00Z'),
        });
        return ok(undefined);
      },
    ),
    deleteSyncObject: jest.fn((a: string, kind: string, id: string) => {
      syncObjects.delete(`${a}|${kind}|${id}`);
      return ok(undefined);
    }),
    syncObjectsByAccount: jest.fn((a: string) =>
      ok([...syncObjects.values()].filter((r) => r.account_id === a)),
    ),
    addSyncDaily: jest.fn(
      (a: string, day: string, up: number, down: number) => {
        const k = `${a}|${day}`;
        const row = syncDaily.get(k) ?? {
          account_id: a,
          day,
          bytes_up: 0,
          bytes_down: 0,
          uploads: 0,
          downloads: 0,
        };
        row.bytes_up += up;
        row.bytes_down += down;
        row.uploads += up > 0 ? 1 : 0;
        row.downloads += down > 0 ? 1 : 0;
        syncDaily.set(k, row);
        return ok(undefined);
      },
    ),
    lastIngestAt: jest.fn(() =>
      ok(ingested.size ? '2026-09-03T12:30:00.000Z' : null),
    ),
    syncDailyByAccount: jest.fn((a: string, start: string, end: string) =>
      ok(
        [...syncDaily.values()].filter(
          (r) => r.account_id === a && r.day >= start && r.day < end,
        ),
      ),
    ),
    upsertStorage: jest.fn(
      (c: string, a: string, bytes: number, files: number) => {
        storage.set(c, {
          crux_id: c,
          author_id: a,
          bytes,
          files,
          updated: new Date(),
        });
        return ok(undefined);
      },
    ),
    deleteStorage: jest.fn((c: string) => {
      storage.delete(c);
      return ok(undefined);
    }),
    storageByAuthor: jest.fn((a: string) =>
      ok([...storage.values()].filter((r) => r.author_id === a)),
    ),
    storageByCrux: jest.fn((c: string) => ok(storage.get(c))),
    addDaily: jest.fn(
      (a: string, c: string, day: string, bytes: number, requests: number) => {
        const k = `${c}|${day}`;
        const row = daily.get(k) ?? {
          author_id: a,
          crux_id: c,
          day,
          bytes: 0,
          requests: 0,
        };
        row.bytes += bytes;
        row.requests += requests;
        daily.set(k, row);
        return ok(undefined);
      },
    ),
    dailyByAuthor: jest.fn((a: string, start: string, end: string) =>
      ok(
        [...daily.values()].filter(
          (r) => r.author_id === a && r.day >= start && r.day < end,
        ),
      ),
    ),
    dailyByCrux: jest.fn((c: string, start: string, end: string) =>
      ok(
        [...daily.values()].filter(
          (r) => r.crux_id === c && r.day >= start && r.day < end,
        ),
      ),
    ),
    ingestSeen: jest.fn((k: string) => ok(ingested.has(k))),
    markIngested: jest.fn((k: string) => {
      ingested.add(k);
      return ok(undefined);
    }),
    cruxForHostname: jest.fn((h: string) =>
      ok(
        h === 'blog.someone.com'
          ? { crux_id: 'c-custom', author_id: 'a1' }
          : undefined,
      ),
    ),
    authorForCrux: jest.fn((c: string) => ok(c === CRUX ? 'a1' : undefined)),
    titlesFor: jest.fn((ids: string[]) =>
      ok(Object.fromEntries(ids.map((i) => [i, i === CRUX ? 'My Crux' : '']))),
    ),
  };
}

describe('UsageService', () => {
  it('storage is recorded at publish and cleared at unpublish; totals per period', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    await svc.recordStorage(CRUX, 'a1', 5000, 3);
    await svc.recordStorage('c2', 'a1', 1000, 1);
    await repo.addDaily('a1', CRUX, '2026-09-02', 700, 7);
    await repo.addDaily('a1', CRUX, '2026-08-31', 999, 9); // last period
    const u = await svc.forAuthor(
      'a1',
      { plan: 'free' },
      new Date('2026-09-03T12:00:00Z'),
    );
    expect(u.period).toEqual({ start: '2026-09-01', end: '2026-10-01' });
    expect(u.storageBytes).toBe(6000);
    expect(u.bandwidthBytes).toBe(700);
    expect(u.requests).toBe(7);
    expect(u.plan.id).toBe('free');
    expect(u.cruxes[0]).toMatchObject({
      cruxId: CRUX,
      storageBytes: 5000,
      files: 3,
      bandwidthBytes: 700,
    });
    const one = await svc.forCrux(CRUX, new Date('2026-09-03T12:00:00Z'));
    expect(one).toMatchObject({
      storageBytes: 5000,
      bandwidthBytes: 700,
      requests: 7,
    });
    await svc.clearStorage(CRUX);
    expect(
      (await svc.forAuthor('a1', null, new Date('2026-09-03T12:00:00Z')))
        .storageBytes,
    ).toBe(1000);
  });

  it('sync storage and transfer are tied to the account and count toward the plan totals', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    const now = new Date('2026-09-03T12:00:00Z');
    await svc.recordStorage(CRUX, 'a1', 5000, 3);
    await svc.recordSyncObject('acct1', 'garden', 'garden', 4000, 'Garden');
    await svc.recordSyncObject('acct1', 'crux', 'c9', 1500, 'Notes');
    await svc.recordTransfer('acct1', 4000, 0, now);
    await svc.recordTransfer('acct1', 0, 2500, now);
    await svc.recordTransfer('acct1', 0, 0, now); // no-op
    await svc.recordTransfer('acct1', 900, 0, new Date('2026-08-30T00:00:00Z')); // last period

    const u = await svc.forAuthor('a1', null, now, 'acct1');
    expect(u.publish.storageBytes).toBe(5000);
    expect(u.sync).toMatchObject({
      storageBytes: 5500,
      gardenBytes: 4000,
      gardenSyncedAt: '2026-09-03T10:00:00.000Z',
      cruxBytes: 1500,
      cruxCount: 1,
      uploadBytes: 4000,
      downloadBytes: 2500,
      transferBytes: 6500,
      uploads: 1,
      downloads: 1,
    });
    expect(u.sync.objects.map((o) => o.id)).toEqual(['garden', 'c9']);
    expect(u.storageBytes).toBe(10500);
    expect(u.bandwidthBytes).toBe(6500);

    await svc.clearSyncObject('acct1', 'garden', 'garden');
    const after = await svc.forAuthor('a1', null, now, 'acct1');
    expect(after.sync.storageBytes).toBe(1500);
    expect(after.sync.gardenSyncedAt).toBeNull();

    // no account → sync is empty, publish totals unchanged
    const noAcct = await svc.forAuthor('a1', null, now);
    expect(noAcct.storageBytes).toBe(5000);
    expect(noAcct.sync.cruxCount).toBe(0);
  });

  it('ingests each log file once, resolves subdomains and custom domains, skips unknown hosts', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    const log = [
      '#Fields: date sc-bytes x-host-header',
      `2026-09-03\t100\t${CRUX}.publish.crux.garden`,
      `2026-09-03\t50\t${CRUX}.publish.crux.garden`,
      '2026-09-03\t30\tblog.someone.com',
      '2026-09-03\t999\tnobody.example',
      '',
    ].join('\n');
    const files = new Map([['logs/a.gz', gzipSync(Buffer.from(log))]]);
    const source = {
      list: async () => [...files.keys()],
      read: async (k: string) => files.get(k)!,
    };
    const first = await svc.ingest(source);
    expect(first).toEqual({ files: 1, bytes: 180, requests: 3, skipped: 1 });
    expect(repo.daily.get(`${CRUX}|2026-09-03`)).toMatchObject({
      bytes: 150,
      requests: 2,
    });
    expect(repo.daily.get('c-custom|2026-09-03')).toMatchObject({
      bytes: 30,
      author_id: 'a1',
    });
    const again = await svc.ingest(source);
    expect(again.files).toBe(0);
    expect(repo.daily.get(`${CRUX}|2026-09-03`)?.bytes).toBe(150);
  });
});
