import { BadRequestException } from '@nestjs/common';
import { BillingService, effectivePlanId } from './billing.service';
import { MockBillingProvider } from './provider';
import type { SubscriptionRow } from './billing.repository';

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
} as never;

function fakeRepo() {
  const rows = new Map<string, SubscriptionRow>();
  const events = new Set<string>();
  const ok = <T>(data: T) => Promise.resolve({ data, error: null });
  return {
    rows,
    events,
    byAccount: jest.fn((a: string) => ok(rows.get(a) ?? null)),
    byCustomer: jest.fn((c: string) =>
      ok([...rows.values()].find((r) => r.customer_id === c) ?? null),
    ),
    bySubscription: jest.fn((s: string) =>
      ok([...rows.values()].find((r) => r.subscription_id === s) ?? null),
    ),
    upsert: jest.fn((row: Omit<SubscriptionRow, 'updated'>) => {
      const saved = { ...row, updated: new Date() } as SubscriptionRow;
      rows.set(row.account_id, saved);
      return ok(saved);
    }),
    setCustomer: jest.fn(() => ok(undefined)),
    accountEmail: jest.fn((a: string) =>
      ok(a === 'acct-1' ? 'd@example.com' : null),
    ),
    eventSeen: jest.fn((id: string) => ok(events.has(id))),
    recordEvent: jest.fn((id: string) => {
      events.add(id);
      return ok(undefined);
    }),
    list: jest.fn(() => ok([...rows.values()])),
  };
}

const email = { send: jest.fn(async () => null) };
beforeEach(() => email.send.mockClear());

const PRICES = {
  price_g_m: { planId: 'grower' as const, interval: 'month' as const },
  price_g_y: { planId: 'grower' as const, interval: 'year' as const },
  price_d_m: { planId: 'gardener' as const, interval: 'month' as const },
};

describe('BillingService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('free by default; catalog lists paid plans with prices', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    const provider = new MockBillingProvider();
    svc.useProvider(provider, PRICES);
    expect(await svc.planIdFor('acct-1')).toBe('free');
    expect(await svc.planIdFor(null)).toBe('free');
    const me = await svc.me('acct-1');
    expect(me.plan.id).toBe('free');
    expect(me.canManage).toBe(false);
    const cat = await svc.catalog();
    expect(cat.plans.map((p) => p.plan.id)).toEqual([
      'free',
      'grower',
      'gardener',
    ]);
    expect(cat.plans[1].prices.map((p) => p.interval)).toEqual([
      'month',
      'year',
    ]);
    expect(cat.plans[2].prices).toHaveLength(1);
    expect(cat.instant).toBe(true);
  });

  it('checkout → (mock pays instantly) → plan is live; portal works; second checkout refused', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    svc.useProvider(new MockBillingProvider(), PRICES);
    const { url } = await svc.checkout('acct-1', 'grower', 'month');
    expect(url).toContain('/billing/success');
    expect(await svc.planIdFor('acct-1')).toBe('grower');
    const me = await svc.me('acct-1');
    expect(me).toMatchObject({
      status: 'active',
      interval: 'month',
      canManage: true,
    });
    expect(me.renewsAt).toBeTruthy();
    expect((await svc.portal('acct-1')).url).toContain('/portal/');
    await expect(svc.checkout('acct-1', 'gardener', 'month')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      svc.checkout('acct-1', 'grower', 'week' as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('webhooks drive state: created → updated to gardener → payment failed → deleted; duplicates ignored', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    const provider = new MockBillingProvider();
    svc.useProvider(provider, PRICES);
    const base = {
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      priceId: 'price_g_m',
      status: 'active' as const,
      currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      trialEnd: null,
      accountId: 'acct-1',
    };
    provider.emit({
      id: 'evt_1',
      type: 'subscription.changed',
      subscription: base,
    });
    expect(await svc.handleWebhook(Buffer.from('{}'), 'sig')).toEqual({
      handled: 'subscription.changed',
    });
    expect(await svc.planIdFor('acct-1')).toBe('grower');
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'd@example.com',
        subject: "You're on Crux Garden Grower",
      }),
    );

    // replay of the same event id is a no-op
    provider.emit({
      id: 'evt_1',
      type: 'subscription.changed',
      subscription: { ...base, priceId: 'price_d_m' },
    });
    expect(await svc.handleWebhook(Buffer.from('{}'), 'sig')).toEqual({
      handled: 'duplicate',
    });
    expect(await svc.planIdFor('acct-1')).toBe('grower');

    // upgrade arrives with no accountId on the payload → resolved via customer
    provider.emit({
      id: 'evt_2',
      type: 'subscription.changed',
      subscription: { ...base, priceId: 'price_d_m', accountId: null },
    });
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(await svc.planIdFor('acct-1')).toBe('gardener');

    // payment failed → past_due keeps the plan for a week, then free
    provider.emit({
      id: 'evt_3',
      type: 'payment.failed',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    });
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect((await svc.me('acct-1')).status).toBe('past_due');
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringMatching(/didn.t go through/),
      }),
    );
    expect(await svc.planIdFor('acct-1')).toBe('gardener');
    const row = repo.rows.get('acct-1')!;
    expect(
      effectivePlanId(
        row,
        new Date(new Date(row.updated).getTime() + 8 * 86_400_000),
      ),
    ).toBe('free');

    // deleted → free immediately, still manageable (customer remains)
    provider.emit({
      id: 'evt_4',
      type: 'subscription.deleted',
      subscription: base,
    });
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(await svc.planIdFor('acct-1')).toBe('free');
    expect((await svc.me('acct-1')).canManage).toBe(true);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Your Crux Garden plan is now Free' }),
    );

    // bad signature → 400
    svc.useProvider(
      {
        ...provider,
        name: 'mock',
        parseWebhook: async () => {
          throw new Error('bad sig');
        },
      } as never,
      PRICES,
    );
    await expect(svc.handleWebhook(Buffer.from('{}'), 'nope')).rejects.toThrow(
      /Webhook rejected/,
    );
  });

  it('sync re-pulls from the provider when a webhook was missed', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    const provider = new MockBillingProvider();
    svc.useProvider(provider, PRICES);
    // a checkout happened at the provider but no webhook arrived
    await provider.createCheckout({
      accountId: 'acct-1',
      email: 'd@example.com',
      customerId: null,
      priceId: 'price_g_y',
      successUrl: 'x',
      cancelUrl: 'y',
      trialDays: 14,
    });
    expect(await svc.planIdFor('acct-1')).toBe('free');
    const me = await svc.sync('acct-1');
    expect(me).toMatchObject({ status: 'trialing', interval: 'year' });
    expect(me.plan.id).toBe('grower');
    expect(me.trialEndsAt).toBeTruthy();
  });
});
