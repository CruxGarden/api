import Stripe from 'stripe';
import { StripeBillingProvider } from './stripe.provider';
import { BillingService, effectivePlanId } from './billing.service';
import type { SubscriptionRow } from './billing.repository';

/**
 * The live webhook path, end to end minus the HTTP socket: payloads signed
 * with Stripe's own scheme → the real provider's signature check and event
 * normalisation → the real handler over an in-memory repository. A tampered
 * signature is refused before anything is parsed.
 */
const SECRET = 'whsec_test_secret_for_signing_only';
const stripe = new Stripe('sk_test_unused', {
  apiVersion: '2025-08-27.basil' as never,
});

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
} as never;
const email = { send: jest.fn(async () => null) };
const ok = <T>(data: T) => Promise.resolve({ data, error: null });

function fakeRepo() {
  const rows = new Map<string, SubscriptionRow>();
  const events = new Set<string>();
  return {
    rows,
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
    setPendingSession: jest.fn(() => ok(undefined)),
    accountEmail: jest.fn(() => ok('d@example.com')),
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
    recordEvent: jest.fn(() => ok(undefined)),
    list: jest.fn(() => ok([...rows.values()])),
  };
}

const PRICES = {
  price_g_m: { planId: 'gardener' as const, interval: 'month' as const },
  price_g_y: { planId: 'gardener' as const, interval: 'year' as const },
};

/** A subscription as Stripe sends it in 2025-08-27+ payloads (periods live on the item). */
const subscription = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  trial_end: null,
  metadata: { accountId: 'acct-1' },
  items: {
    data: [
      {
        id: 'si_1',
        price: { id: 'price_g_m' },
        current_period_start: 1_788_220_800, // 2026-09-01T00:00:00Z
        current_period_end: 1_790_812_800, // 2026-10-01T00:00:00Z
      },
    ],
  },
  ...over,
});

function signed(
  type: string,
  object: unknown,
  id = `evt_${type}_${Math.random().toString(36).slice(2)}`,
) {
  const payload = JSON.stringify({
    id,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: SECRET,
  });
  return { body: Buffer.from(payload), signature, id };
}

describe('Stripe webhooks, signed end to end', () => {
  let provider: StripeBillingProvider;
  let repo: ReturnType<typeof fakeRepo>;
  let svc: BillingService;

  beforeEach(() => {
    // The provider only needs the Stripe SDK for signature checks here; no network.
    provider = new StripeBillingProvider(stripe, SECRET, false);
    // `subscription.changed` re-fetches live state; return "the same" so the
    // payload is what counts.
    jest
      .spyOn(provider, 'fetchSubscription')
      .mockImplementation(async () => null);
    repo = fakeRepo();
    svc = new BillingService(repo as never, logger, email as never);
    svc.useProvider(provider, PRICES);
    email.send.mockClear();
  });

  it('refuses a tampered or missing signature before parsing anything', async () => {
    const { body } = signed('customer.subscription.updated', subscription());
    await expect(svc.handleWebhook(body, 't=1,v1=deadbeef')).rejects.toThrow(
      /Webhook rejected/,
    );
    await expect(svc.handleWebhook(body, undefined)).rejects.toThrow(
      /Webhook rejected/,
    );
    expect(repo.claimEvent).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(0);
  });

  it('created → cancel at period end → resumed, with a duplicate delivery ignored', async () => {
    const created = signed('customer.subscription.created', subscription());
    expect(await svc.handleWebhook(created.body, created.signature)).toEqual({
      handled: 'subscription.changed',
    });
    expect(await svc.planIdFor('acct-1')).toBe('gardener');
    expect((await svc.me('acct-1')).renewsAt).toBe('2026-10-01T00:00:00.000Z');

    const cancelling = signed(
      'customer.subscription.updated',
      subscription({ cancel_at_period_end: true }),
    );
    await svc.handleWebhook(cancelling.body, cancelling.signature);
    expect((await svc.me('acct-1')).cancelAtPeriodEnd).toBe(true);

    // Stripe retried the same event: same id, same body → duplicate, no second apply
    const upserts = repo.upsert.mock.calls.length;
    expect(
      await svc.handleWebhook(cancelling.body, cancelling.signature),
    ).toEqual({
      handled: 'duplicate',
    });
    expect(repo.upsert.mock.calls.length).toBe(upserts);

    const resumed = signed(
      'customer.subscription.updated',
      subscription({ cancel_at_period_end: false }),
    );
    await svc.handleWebhook(resumed.body, resumed.signature);
    expect((await svc.me('acct-1')).cancelAtPeriodEnd).toBe(false);
  });

  it('invoice.payment_failed (2025-08-27 parent shape) → past_due with a 7-day grace, once', async () => {
    const created = signed('customer.subscription.created', subscription());
    await svc.handleWebhook(created.body, created.signature);

    const invoice = {
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_1',
      status: 'open',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_1' },
      },
    };
    const failed = signed('invoice.payment_failed', invoice);
    expect(await svc.handleWebhook(failed.body, failed.signature)).toEqual({
      handled: 'payment.failed',
    });
    const me = await svc.me('acct-1');
    expect(me.status).toBe('past_due');
    expect(me.plan.id).toBe('gardener'); // kept during grace
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringMatching(/didn.t go through/),
      }),
    );
    const row = repo.rows.get('acct-1')!;
    const since = new Date(row.past_due_since as Date).getTime();
    expect(effectivePlanId(row, new Date(since + 8 * 86_400_000))).toBe('free');

    // a second failed invoice does not restart the clock or re-mail
    const mails = email.send.mock.calls.length;
    const again = signed('invoice.payment_failed', { ...invoice, id: 'in_2' });
    await svc.handleWebhook(again.body, again.signature);
    expect(repo.rows.get('acct-1')!.past_due_since).toEqual(row.past_due_since);
    expect(email.send.mock.calls.length).toBe(mails);

    // payment recovered: Stripe sends the subscription active again
    const active = signed(
      'customer.subscription.updated',
      subscription({ status: 'active' }),
    );
    await svc.handleWebhook(active.body, active.signature);
    expect((await svc.me('acct-1')).status).toBe('active');
    expect(repo.rows.get('acct-1')!.past_due_since).toBeNull();
  });

  it('customer.subscription.deleted → free, still manageable; a trial that ended paused → no entitlement', async () => {
    const created = signed('customer.subscription.created', subscription());
    await svc.handleWebhook(created.body, created.signature);
    const deleted = signed(
      'customer.subscription.deleted',
      subscription({ status: 'canceled' }),
    );
    expect(await svc.handleWebhook(deleted.body, deleted.signature)).toEqual({
      handled: 'subscription.deleted',
    });
    expect(await svc.planIdFor('acct-1')).toBe('free');
    expect((await svc.me('acct-1')).canManage).toBe(true);

    const paused = signed(
      'customer.subscription.paused',
      subscription({ id: 'sub_2', status: 'paused' }),
    );
    await svc.handleWebhook(paused.body, paused.signature);
    expect(await svc.planIdFor('acct-1')).toBe('free');
  });

  it('an event Stripe sends that we do not handle is acknowledged as ignored', async () => {
    const other = signed('charge.succeeded', { id: 'ch_1', object: 'charge' });
    expect(await svc.handleWebhook(other.body, other.signature)).toEqual({
      handled: 'ignored',
    });
    expect(repo.rows.size).toBe(0);
  });
});
