import { NotificationsService, notice } from './notifications.service';
import type { AccountUsage } from './usage.service';
import { PLANS } from './plans';

const GB = 1024 ** 3;
function usage(
  over: Partial<{ storage: number; bandwidth: number; store: number }>,
): AccountUsage {
  const plan = PLANS.free;
  return {
    period: { start: '2026-09-01', end: '2026-10-01' },
    plan,
    storageBytes: over.storage ?? 0,
    bandwidthBytes: over.bandwidth ?? 0,
    requests: 0,
    store: {
      storageBytes: 0,
      keys: 0,
      reads: over.store ?? 0,
      writes: 0,
      requests: over.store ?? 0,
    },
  } as unknown as AccountUsage;
}

describe('NotificationsService', () => {
  it('decides which notices are due (soft supersedes 80 %)', () => {
    expect(NotificationsService.due(usage({ storage: 0.5 * GB }))).toEqual([]);
    expect(NotificationsService.due(usage({ storage: 0.85 * GB }))).toEqual([
      'storage_80',
    ]);
    expect(
      NotificationsService.due(
        usage({ storage: 1.2 * GB, bandwidth: 0.9 * GB, store: 90_000 }),
      ),
    ).toEqual(['storage_soft', 'bandwidth_80', 'store_80']);
  });

  it('sends each due notice once per period, with the plan named', async () => {
    const sent = new Set<string>();
    const repo = {
      notificationSent: jest.fn(async (a: string, k: string, p: string) => ({
        data: sent.has(`${a}|${k}|${p}`),
        error: null,
      })),
      markNotified: jest.fn(async (a: string, k: string, p: string) => {
        sent.add(`${a}|${k}|${p}`);
        return { data: undefined, error: null };
      }),
      accountEmailFor: jest.fn(async () => ({
        data: 'd@example.com',
        error: null,
      })),
    };
    const email = {
      send: jest.fn<
        Promise<null>,
        [{ email: string; subject: string; body: string }]
      >(async () => null),
    };
    const u = usage({ storage: 0.9 * GB });
    const svc = new NotificationsService(
      { forAuthor: jest.fn(async () => u) } as never,
      { planIdFor: jest.fn(async () => 'free') } as never,
      email as never,
      repo as never,
      {
        createChildLogger: () => ({ info: jest.fn(), error: jest.fn() }),
      } as never,
    );
    expect(await svc.afterWrite('a1', 'acct')).toEqual(['storage_80']);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'd@example.com',
        subject: "You're using most of your Free storage",
      }),
    );
    // again in the same period → nothing
    expect(await svc.afterWrite('a1', 'acct')).toEqual([]);
    expect(email.send).toHaveBeenCalledTimes(1);
    // no account → nothing
    expect(await svc.afterWrite('a1', null)).toEqual([]);
  });

  it('notice copy never threatens a cut-off', () => {
    for (const kind of [
      'storage_80',
      'storage_soft',
      'bandwidth_80',
      'bandwidth_soft',
      'store_80',
    ] as const) {
      const n = notice(
        kind,
        usage({ storage: 1.2 * GB, bandwidth: 1.2 * GB, store: 90_000 }),
      );
      expect(n.body).toMatch(/Nothing is cut off/);
      expect(n.body).toMatch(/Settings → Plan/);
    }
  });
});
