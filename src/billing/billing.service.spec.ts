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
    claimEvent: jest.fn((id: string) => {
      if (events.has(id)) return ok(false);
      events.add(id);
      return ok(true);
    }),
    releaseEvent: jest.fn((id: string) => {
      events.delete(id);
      return ok(undefined);
    }),
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
  price_g_m: { planId: 'gardener' as const, interval: 'month' as const },
  price_g_y: { planId: 'gardener' as const, interval: 'year' as const },
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
    expect(cat.plans.map((p) => p.plan.id)).toEqual(['free', 'gardener']);
    expect(cat.plans[1].prices.map((p) => p.interval)).toEqual([
      'month',
      'year',
    ]);
    expect(cat.instant).toBe(true);
  });

  it('checkout → (mock pays instantly) → plan is live; portal works; second checkout refused', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    svc.useProvider(new MockBillingProvider(), PRICES);
    const { url } = await svc.checkout('acct-1', 'gardener', 'month');
    expect(url).toContain('/billing/success');
    expect(await svc.planIdFor('acct-1')).toBe('gardener');
    const me = await svc.me('acct-1');
    expect(me).toMatchObject({
      status: 'active',
      interval: 'month',
      canManage: true,
    });
    expect(me.renewsAt).toBeTruthy();
    expect((await svc.portal('acct-1')).url).toContain('/portal/');
    await expect(svc.checkout('acct-1', 'gardener', 'year')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      svc.checkout('acct-1', 'gardener', 'week' as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('webhooks drive state: created → switched to yearly → payment failed → deleted; duplicates ignored', async () => {
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
    expect(await svc.planIdFor('acct-1')).toBe('gardener');
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'd@example.com',
        subject: "You're on Crux Garden Gardener",
      }),
    );

    // replay of the same event id is a no-op
    provider.emit({
      id: 'evt_1',
      type: 'subscription.changed',
      subscription: { ...base, priceId: 'price_g_y' },
    });
    expect(await svc.handleWebhook(Buffer.from('{}'), 'sig')).toEqual({
      handled: 'duplicate',
    });
    expect(await svc.planIdFor('acct-1')).toBe('gardener');

    // upgrade arrives with no accountId on the payload → resolved via customer
    provider.emit({
      id: 'evt_2',
      type: 'subscription.changed',
      subscription: { ...base, priceId: 'price_g_y', accountId: null },
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

  it('a webhook that throws releases its claim so the retry is processed; stale payloads defer to the provider', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    const provider = new MockBillingProvider();
    svc.useProvider(provider, PRICES);
    const snap = {
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
    // the provider already knows this subscription is yearly; the
    // delivery in flight is an older "gardener" payload
    provider.subscriptions.set('sub_1', { ...snap, priceId: 'price_g_y' });
    provider.emit({
      id: 'evt_1',
      type: 'subscription.changed',
      subscription: snap,
    });
    repo.upsert.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(svc.handleWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow(
      'db down',
    );
    expect(repo.releaseEvent).toHaveBeenCalledWith('evt_1');
    // Stripe retries with the same id → processed this time, from live state
    provider.emit({
      id: 'evt_1',
      type: 'subscription.changed',
      subscription: snap,
    });
    expect(await svc.handleWebhook(Buffer.from('{}'), 'sig')).toEqual({
      handled: 'subscription.changed',
    });
    expect(await svc.planIdFor('acct-1')).toBe('gardener');
  });

  it('the past-due grace clock starts at the first failure and is not reset by retries', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    const provider = new MockBillingProvider();
    svc.useProvider(provider, PRICES);
    await svc.checkout('acct-1', 'gardener', 'month');
    const subId = repo.rows.get('acct-1')!.subscription_id!;
    const custId = repo.rows.get('acct-1')!.customer_id!;
    const fail = (id: string) =>
      provider.emit({
        id,
        type: 'payment.failed',
        customerId: custId,
        subscriptionId: subId,
      });
    fail('evt_f1');
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    const since = repo.rows.get('acct-1')!.past_due_since;
    expect(since).toBeTruthy();
    const mails = email.send.mock.calls.length;
    fail('evt_f2');
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    // a second dunning attempt neither restarts the clock nor re-mails
    expect(repo.rows.get('acct-1')!.past_due_since).toEqual(since);
    expect(email.send.mock.calls.length).toBe(mails);
    const row = repo.rows.get('acct-1')!;
    const t = new Date(since as Date).getTime();
    expect(effectivePlanId(row, new Date(t + 6 * 86_400_000))).toBe('gardener');
    expect(effectivePlanId(row, new Date(t + 8 * 86_400_000))).toBe('free');
  });

  it('sync sees a new subscription after the stored one was canceled', async () => {
    const repo = fakeRepo();
    const svc = new BillingService(repo as never, logger, email as never);
    const provider = new MockBillingProvider();
    svc.useProvider(provider, PRICES);
    await svc.checkout('acct-1', 'gardener', 'month');
    const old = repo.rows.get('acct-1')!;
    // canceled at the provider, then re-subscribed on the same customer (webhooks missed)
    provider.subscriptions.set(old.subscription_id!, {
      ...provider.subscriptions.get(old.subscription_id!)!,
      status: 'canceled',
    });
    await provider.createCheckout({
      accountId: 'acct-1',
      email: 'd@example.com',
      customerId: old.customer_id!,
      priceId: 'price_g_y',
      trialDays: 0,
      successUrl: 'https://x/ok',
      cancelUrl: 'https://x/no',
    });
    await svc.sync('acct-1');
    expect(await svc.planIdFor('acct-1')).toBe('gardener');
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
    expect(me.plan.id).toBe('gardener');
    expect(me.trialEndsAt).toBeTruthy();
  });
});
