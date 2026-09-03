import { billingPeriod, planFor, PLANS } from './plans';

describe('plans', () => {
  it('defaults to free and honours author.meta.plan when known', () => {
    expect(planFor(undefined).id).toBe('free');
    expect(planFor({ plan: 'nope' }).id).toBe('free');
    expect(planFor({ plan: 'free' })).toBe(PLANS.free);
    expect(PLANS.free.storageBytes).toBe(1024 ** 3);
  });
  it('billing period is the UTC calendar month', () => {
    expect(billingPeriod(new Date('2026-09-03T23:59:00Z'))).toEqual({
      start: '2026-09-01',
      end: '2026-10-01',
    });
    expect(billingPeriod(new Date('2026-12-31T00:00:00Z'))).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
  });
});
