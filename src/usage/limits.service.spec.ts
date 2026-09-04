import { LimitsService, OverLimitException } from './limits.service';

const GB = 1024 ** 3;

function svc(planId: string, storageBytes: number) {
  const usage = { forAuthor: jest.fn(async () => ({ storageBytes })) };
  const billing = { planIdFor: jest.fn(async () => planId) };
  return new LimitsService(usage as never, billing as never);
}

describe('LimitsService (grace-first)', () => {
  it('allows up to the soft limit without a warning', async () => {
    const r = await svc('free', 0.5 * GB).assertStorage('a1', 'acct', 0.5 * GB);
    expect(r).toMatchObject({ limit: GB, warn: false });
  });

  it('warns between soft limit and 2×, refuses beyond 2× with a 402 naming the plan', async () => {
    const warn = await svc('free', 1.2 * GB).assertStorage(
      'a1',
      'acct',
      0.1 * GB,
    );
    expect(warn.warn).toBe(true);
    await expect(
      svc('free', 1.9 * GB).assertStorage('a1', 'acct', 0.2 * GB),
    ).rejects.toThrow(OverLimitException);
    try {
      await svc('free', 1.9 * GB).assertStorage(
        'a1',
        'acct',
        0.2 * GB,
        0,
        'publish',
      );
    } catch (e) {
      const res = (e as OverLimitException).getResponse() as Record<
        string,
        unknown
      >;
      expect((e as OverLimitException).getStatus()).toBe(402);
      expect(res.kind).toBe('storage');
      expect(String(res.message)).toMatch(/Free plan/);
      expect(String(res.message)).toMatch(/upgrade your plan/);
    }
  });

  it('a replaced object only counts its growth; bigger plans have bigger lines', async () => {
    // 1.95 GB used, republishing a 1 GB crux as 1.1 GB → net 2.05 GB > 2 GB hard line
    await expect(
      svc('free', 1.95 * GB).assertStorage('a1', 'acct', 1.1 * GB, 1 * GB),
    ).rejects.toThrow();
    // same numbers on Grower (10 GB) are nowhere near the line
    const r = await svc('grower', 1.95 * GB).assertStorage(
      'a1',
      'acct',
      1.1 * GB,
      1 * GB,
    );
    expect(r.limit).toBe(10 * GB);
    expect(r.warn).toBe(false);
  });
});
