import {
  NotificationsService,
  includedNotice,
  includedNoticePeriod,
  notice,
  type IncludedAllowance,
} from './notifications.service';
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
      markNotified: jest.fn(async (a: string, k: string, p: string) => {
        const key = `${a}|${k}|${p}`;
        if (sent.has(key)) return { data: false, error: null };
        sent.add(key);
        return { data: true, error: null };
      }),
      unmarkNotified: jest.fn(async (a: string, k: string, p: string) => {
        sent.delete(`${a}|${k}|${p}`);
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

describe('Included collaboration allowance notices', () => {
  const allowance = (used: number): IncludedAllowance => ({
    planName: 'Gardener',
    usedMicrodollars: used,
    limitMicrodollars: 4_000_000,
    minimumMicrodollars: 12_800,
  });
  function harness() {
    const ledger: {
      account: string;
      kind: string;
      period: string;
      at: Date;
    }[] = [];
    let clock = new Date('2026-11-02T12:00:00Z');
    const repo = {
      notificationSentSince: jest.fn(
        async (a: string, kinds: string[], since: Date) => ({
          data: ledger.some(
            (n) =>
              n.account === a &&
              kinds.includes(n.kind) &&
              n.at.getTime() > since.getTime(),
          ),
          error: null,
        }),
      ),
      markNotified: jest.fn(async (a: string, k: string, p: string) => {
        if (
          ledger.some((n) => n.account === a && n.kind === k && n.period === p)
        )
          return { data: false, error: null };
        ledger.push({ account: a, kind: k, period: p, at: clock });
        return { data: true, error: null };
      }),
      unmarkNotified: jest.fn(async () => ({ data: undefined, error: null })),
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
    const svc = new NotificationsService(
      {} as never,
      {} as never,
      email as never,
      repo as never,
      {
        createChildLogger: () => ({ info: jest.fn(), error: jest.fn() }),
      } as never,
    );
    return {
      svc,
      email,
      repo,
      at: (d: Date) => (clock = d),
      now: () => clock,
    };
  }
  it('is due at 80 % and when not even a minimal request fits', () => {
    expect(NotificationsService.includedDue(allowance(3_100_000))).toBeNull();
    expect(NotificationsService.includedDue(allowance(3_200_000))).toBe(
      'included_80',
    );
    expect(NotificationsService.includedDue(allowance(3_990_000))).toBe(
      'included_full',
    );
    expect(NotificationsService.includedDue(allowance(4_000_000))).toBe(
      'included_full',
    );
    expect(
      NotificationsService.includedDue({
        ...allowance(10),
        limitMicrodollars: 0,
      }),
    ).toBeNull();
  });
  it('sends each notice at most once in any 30 days, across the bucket boundary', async () => {
    const h = harness();
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_200_000), h.now()),
    ).toBe('included_80');
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_300_000), h.now()),
    ).toBeNull();
    // A new fixed bucket a few days later still finds the recent notice.
    const later = new Date(h.now().getTime() + 2 * 86_400_000);
    expect(includedNoticePeriod(later)).not.toBe(includedNoticePeriod(h.now()));
    h.at(later);
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_300_000), later),
    ).toBeNull();
    // Reaching full is its own notice, once.
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_999_000), later),
    ).toBe('included_full');
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_999_000), later),
    ).toBeNull();
    expect(h.email.send).toHaveBeenCalledTimes(2);
    // Thirty-one days on, the 80 % notice may go again.
    const month = new Date(later.getTime() + 31 * 86_400_000);
    h.at(month);
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_300_000), month),
    ).toBe('included_80');
  });
  it('does not follow a full notice with an 80 % one in the same 30 days', async () => {
    const h = harness();
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(4_000_000), h.now()),
    ).toBe('included_full');
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_300_000), h.now()),
    ).toBeNull();
    expect(h.email.send).toHaveBeenCalledTimes(1);
  });
  it('gives the claim back when the email fails, so it can be sent later', async () => {
    const h = harness();
    h.email.send.mockRejectedValueOnce(new Error('SES down'));
    expect(
      await h.svc.afterIncludedUsage('acct', allowance(3_200_000), h.now()),
    ).toBeNull();
    expect(h.repo.unmarkNotified).toHaveBeenCalledWith(
      'acct',
      'included_80',
      includedNoticePeriod(h.now()),
    );
  });
  it('speaks in dollars and included collaboration, never "AI"', () => {
    for (const kind of ['included_80', 'included_full'] as const) {
      const n = includedNotice(kind, allowance(3_200_000));
      expect(n.body).toContain('$3.20 of $4.00');
      expect(`${n.subject} ${n.body}`).toMatch(/included collaboration/);
      expect(`${n.subject} ${n.body}`).not.toMatch(/\bAI\b/);
    }
  });
});
