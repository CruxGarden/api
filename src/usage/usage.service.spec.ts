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
  const reconRows = new Map<string, Record<string, unknown>>();
  const storeBytesRows = new Map<
    string,
    { crux_id: string; bytes: number; keys: number }
  >();
  const storeDaily = new Map<
    string,
    {
      author_id: string;
      crux_id: string;
      day: string;
      reads: number;
      writes: number;
    }
  >();
  const periodRows: Array<
    Record<string, unknown> & { author_id: string; period_start: string }
  > = [];
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
    recon: new Map<string, Record<string, unknown>>(),
    periods: [] as Record<string, unknown>[],
    meteredBytesForDay: jest.fn((day: string) =>
      ok(
        [...daily.values()]
          .filter((r) => r.day === day)
          .reduce((s, r) => s + r.bytes, 0),
      ),
    ),
    upsertReconciliation: jest.fn(function (
      this: unknown,
      row: { day: string },
    ) {
      reconRows.set(row.day, { ...row, checked_at: new Date() });
      return ok(undefined);
    }),
    listReconciliation: jest.fn((limit = 31) =>
      ok(
        [...reconRows.values()]
          .sort((a, b) => String(b.day).localeCompare(String(a.day)))
          .slice(0, limit),
      ),
    ),
    authorsActiveInPeriod: jest.fn((start: string, end: string) =>
      ok([
        ...new Set([
          ...[...storage.values()].map((r) => r.author_id),
          ...[...daily.values()]
            .filter((r) => r.day >= start && r.day < end)
            .map((r) => r.author_id),
        ]),
      ]),
    ),
    authorAccount: jest.fn((a: string) =>
      ok({ account_id: `acct-${a}`, meta: { plan: 'free' } }),
    ),
    periodFinalized: jest.fn((a: string, start: string) =>
      ok(periodRows.some((p) => p.author_id === a && p.period_start === start)),
    ),
    insertPeriod: jest.fn(
      (row: { author_id: string; period_start: string }) => {
        if (
          !periodRows.some(
            (p) =>
              p.author_id === row.author_id &&
              p.period_start === row.period_start,
          )
        )
          periodRows.push({ ...row, finalized_at: new Date() });
        return ok(undefined);
      },
    ),
    periodsForAuthor: jest.fn((a: string) =>
      ok(periodRows.filter((p) => p.author_id === a)),
    ),
    storeBytesRows,
    storeBytesByAuthor: jest.fn(() => ok([...storeBytesRows.values()])),
    storeBytesByCrux: jest.fn((c: string) =>
      ok(storeBytesRows.get(c) ?? { bytes: 0, keys: 0 }),
    ),
    addStoreDaily: jest.fn(
      (a: string, c: string, day: string, reads: number, writes: number) => {
        const k = `${c}|${day}`;
        const row = storeDaily.get(k) ?? {
          author_id: a,
          crux_id: c,
          day,
          reads: 0,
          writes: 0,
        };
        row.reads += reads;
        row.writes += writes;
        storeDaily.set(k, row);
        return ok(undefined);
      },
    ),
    storeDailyByAuthor: jest.fn((a: string, start: string, end: string) =>
      ok(
        [...storeDaily.values()].filter(
          (r) => r.author_id === a && r.day >= start && r.day < end,
        ),
      ),
    ),
    storeDailyByCrux: jest.fn((c: string, start: string, end: string) =>
      ok(
        [...storeDaily.values()].filter(
          (r) => r.crux_id === c && r.day >= start && r.day < end,
        ),
      ),
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

  it('reconciles metered bytes against CloudFront and flags gaps, forgiving tiny days', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    const now = new Date('2026-09-04T06:00:00Z');
    // 09-03: we saw 95 MB, CloudFront says 100 MB → 5% (at the line, ok)
    await repo.addDaily('a1', CRUX, '2026-09-03', 95 * 1024 * 1024, 10);
    // 09-02: we saw 80 MB of 100 MB → 20% gap
    await repo.addDaily('a1', CRUX, '2026-09-02', 80 * 1024 * 1024, 10);
    // 09-01: quiet day, 100 bytes at the edge → ok regardless
    const edge = {
      bytesDownloaded: async (day: string) =>
        day === '2026-09-01'
          ? 100
          : day === '2026-08-31'
            ? null
            : 100 * 1024 * 1024,
    };
    const days = await svc.reconcile(edge, 4, now);
    expect(days.map((d) => [d.day, d.status])).toEqual([
      ['2026-09-03', 'ok'],
      ['2026-09-02', 'gap'],
      ['2026-09-01', 'ok'],
      ['2026-08-31', 'nodata'],
    ]);
    expect(days[1].gapPct).toBe(20);
    const u = await svc.forAuthor('a1', null, now, 'acct1');
    expect(u.reconciliation?.day).toBe('2026-09-03');
    expect(u.reconciliation?.status).toBe('ok');
    expect((await svc.reconciliationHistory()).length).toBe(4);
  });

  it('budgets carry a soft limit and settlement waits for the grace window', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    const GB = 1024 * 1024 * 1024;
    await svc.recordStorage(CRUX, 'a1', GB + 1, 1); // just over the plan line
    const u = await svc.forAuthor('a1', null, new Date('2026-09-10T00:00:00Z'));
    expect(u.budgets.storage).toMatchObject({
      limit: GB,
      used: GB + 1,
      softLimit: Math.round(GB * 1.1),
      over: true,
      overSoft: false,
    });
    expect(u.settlement).toEqual({
      finalizesAt: '2026-10-03T00:00:00.000Z',
      isFinal: false,
      graceHours: 48,
    });
  });

  it('closes the previous period only after grace, once per author, judging "over" at the soft limit', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    await svc.recordStorage(CRUX, 'a1', 5000, 3);
    await repo.addDaily('a1', CRUX, '2026-08-15', 1200 * 1024 * 1024, 99); // > 1.1 GB
    await repo.addDaily('a2', 'c2', '2026-08-20', 10, 1);
    await repo.addDaily('a3', 'c3', '2026-07-20', 10, 1); // not this period

    // 2026-09-02T12:00 is inside the 48h grace → nothing closes yet
    const early = await svc.closePeriods(new Date('2026-09-02T12:00:00Z'));
    expect(early).toMatchObject({
      period: { start: '2026-08-01', end: '2026-09-01' },
      closed: 0,
      waitingUntil: '2026-09-03T00:00:00.000Z',
    });

    const done = await svc.closePeriods(new Date('2026-09-03T00:00:01Z'));
    expect(done.closed).toBe(2);
    const a1 = (await svc.periodsForAuthor('a1'))[0];
    expect(a1).toMatchObject({
      period: { start: '2026-08-01', end: '2026-09-01' },
      planId: 'free',
      publishStorageBytes: 5000,
      publishBandwidthBytes: 1200 * 1024 * 1024,
      requests: 99,
      overStorage: false,
      overBandwidth: true,
      reconciliationStatus: null,
    });
    // idempotent
    expect(
      (await svc.closePeriods(new Date('2026-09-04T00:00:00Z'))).closed,
    ).toBe(0);
    expect((await svc.periodsForAuthor('a1')).length).toBe(1);
    expect((await svc.periodsForAuthor('a3')).length).toBe(0);
  });

  it('counts Crux Store requests in memory, flushes per crux per day, and reports bytes + requests', async () => {
    const repo = fakeRepo();
    const svc = new UsageService(repo as never, logger);
    const now = new Date('2026-09-03T12:00:00Z');
    repo.storeBytesRows.set(CRUX, { crux_id: CRUX, bytes: 2048, keys: 3 });
    // authorForCrux in the fake resolves CRUX → 'a1' (see fakeRepo); unknown cruxes are dropped
    svc.noteStoreRequest(CRUX, 'read', now);
    svc.noteStoreRequest(CRUX, 'read', now);
    svc.noteStoreRequest(CRUX, 'write', now);
    svc.noteStoreRequest('00000000-0000-4000-8000-000000000000', 'read', now);
    expect(await svc.flushStoreCounts()).toBe(1);
    expect(repo.addStoreDaily).toHaveBeenCalledWith(
      'a1',
      CRUX,
      '2026-09-03',
      2,
      1,
    );
    // a second flush with nothing buffered is a no-op
    expect(await svc.flushStoreCounts()).toBe(0);

    const u = await svc.forAuthor('a1', null, now);
    expect(u.store).toEqual({
      storageBytes: 2048,
      keys: 3,
      reads: 2,
      writes: 1,
      requests: 3,
    });
    expect(u.storageBytes).toBe(2048); // store bytes count toward storage
    expect(u.budgets.storeRequests).toMatchObject({ used: 3, limit: 100_000 });
    expect(u.cruxes[0]).toMatchObject({
      cruxId: CRUX,
      storeBytes: 2048,
      storeKeys: 3,
      storeReads: 2,
      storeWrites: 1,
    });
    const one = await svc.forCrux(CRUX, now);
    expect(one).toMatchObject({
      storeBytes: 2048,
      storeReads: 2,
      storeWrites: 1,
    });
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
