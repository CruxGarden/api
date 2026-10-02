import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { postgresFixture } from './support/postgres';
import { BillingRepository } from '../src/billing/billing.repository';
import { BillingService } from '../src/billing/billing.service';
import { BillingOperationsRepository } from '../src/billing/operations.repository';
import { MockBillingProvider } from '../src/billing/provider';
import { StripeBillingProvider } from '../src/billing/stripe.provider';
import { LoggerService } from '../src/common/services/logger.service';

describe('billing closure and authenticated delivery recovery', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let repo: BillingRepository;
  let operations: BillingOperationsRepository;
  let service: BillingService;
  let provider: MockBillingProvider;
  const account = randomUUID(),
    home = randomUUID();
  const logger = new LoggerService();
  const email = { send: jest.fn(async () => null) };
  const env = { ...process.env };
  const restart = () => {
    service = new BillingService(
      repo,
      logger,
      email as never,
      undefined,
      operations,
    );
    service.useProvider(provider, {
      price_month: { planId: 'gardener', interval: 'month' },
    });
  };
  beforeAll(async () => {
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_TRIAL_DAYS = '0';
    fixture = await postgresFixture();
    await fixture.db.query()('homes').insert({
      id: home,
      name: 'Closure fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await fixture.db.query()('accounts').insert({
      id: account,
      home_id: home,
      email: 'closure@example.test',
      role: 'author',
    });
    repo = new BillingRepository(fixture.db, logger);
    operations = new BillingOperationsRepository(fixture.db, logger);
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      'billing_notifications',
      'billing_delivery_failures',
      'billing_checkout_attempts',
      'billing_account_state',
      'billing_events',
      'subscriptions',
    ])
      await fixture.db.query()(table).delete();
    await fixture.db
      .query()('accounts')
      .where({ id: account })
      .update({ deleted: null });
    provider = new MockBillingProvider();
    restart();
    await service.checkout(account, 'gardener', 'month');
    email.send.mockClear();
  });
  afterAll(async () => {
    process.env = { ...env };
    await fixture?.close();
  });

  const closed = async () => {
    const row = (await repo.byAccount(account)).data!;
    await service.closeAccount(account);
    await fixture.db
      .query()('accounts')
      .where({ id: account })
      .update({ deleted: new Date() });
    return {
      id: 'evt_after_close',
      type: 'subscription.deleted' as const,
      subscription: provider.subscriptions.get(row.subscription_id!)!,
    };
  };
  it('records a new cancellation after closure, survives restart and acknowledges duplicates without changing the closed projection', async () => {
    const event = await closed();
    const before = (await repo.byAccount(account)).data;
    const notices = await fixture.db.query()('billing_notifications');
    restart();
    provider.emit(event);
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'fixture'),
    ).resolves.toEqual({ handled: 'account.closed' });
    expect((await repo.byAccount(account)).data).toEqual(before);
    expect(await fixture.db.query()('billing_notifications')).toEqual(notices);
    expect(
      (await fixture.db.query()('billing_events').first()).payload.outcome,
    ).toBe('account.closed');
    restart();
    provider.emit(event);
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'fixture'),
    ).resolves.toEqual({ handled: 'duplicate' });
    await expect(service.sync(account)).rejects.toThrow('Account not found');
    expect(
      await fixture.db
        .query()('billing_delivery_failures')
        .whereNull('recovered_at'),
    ).toHaveLength(0);
    expect(email.send).not.toHaveBeenCalled();
  });
  it.each(['fence', 'customer', 'subscription', 'provider'] as const)(
    'refuses closed-owner delivery without matching %s proof',
    async (missing) => {
      const event = await closed();
      if (missing === 'fence')
        await fixture.db.query()('billing_account_state').delete();
      else if (missing === 'provider')
        await fixture.db.query()('subscriptions').update({ provider: 'other' });
      else if (missing === 'customer')
        event.subscription.customerId = 'cus_foreign';
      else event.subscription.subscriptionId = 'sub_foreign';
      provider.emit(event);
      await expect(
        service.handleWebhook(Buffer.from('{}'), 'fixture'),
      ).rejects.toThrow();
      expect(await fixture.db.query()('billing_events')).toHaveLength(0);
      expect(
        await fixture.db
          .query()('billing_delivery_failures')
          .whereNull('recovered_at'),
      ).toHaveLength(1);
    },
  );

  it('rolls back a refused closed-owner completion and retries the retained receipt after restart', async () => {
    const event = await closed();
    const db = fixture.db.query();
    await db.raw(
      "CREATE FUNCTION refuse_closed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload IS NOT NULL THEN RAISE EXCEPTION 'fixture receipt refusal'; END IF; RETURN NEW; END $$",
    );
    await db.raw(
      'CREATE TRIGGER refuse_closed_receipt BEFORE UPDATE ON billing_events FOR EACH ROW EXECUTE FUNCTION refuse_closed_receipt()',
    );
    try {
      provider.emit(event);
      await expect(
        service.handleWebhook(Buffer.from('{}'), 'fixture'),
      ).rejects.toThrow('Could not complete billing event');
      expect(await db('billing_events')).toHaveLength(0);
      expect((await repo.byAccount(account)).data!.plan_id).toBe('free');
    } finally {
      await db.raw('DROP TRIGGER refuse_closed_receipt ON billing_events');
      await db.raw('DROP FUNCTION refuse_closed_receipt()');
    }
    restart();
    provider.emit(event);
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'fixture'),
    ).resolves.toEqual({ handled: 'account.closed' });
    expect(
      await db('billing_delivery_failures').whereNull('recovered_at'),
    ).toHaveLength(0);
  });

  it('monitors a signed checkout provider timeout, recovers on redelivery and deduplicates during an outage; rejects invalid signatures without monitoring', async () => {
    const row = (await repo.byAccount(account)).data!;
    const stripe = new Stripe('sk_test_unused');
    const secret = 'whsec_fixture_only';
    const adapter = new StripeBillingProvider(stripe, secret, false);
    const retrieve = jest
      .spyOn(stripe.subscriptions, 'retrieve')
      .mockRejectedValueOnce(new Error('fixture network timeout'));
    const live = {
      id: row.subscription_id!,
      customer: row.customer_id!,
      status: 'active',
      cancel_at_period_end: false,
      trial_end: null,
      metadata: { accountId: account },
      items: {
        data: [
          {
            price: { id: 'price_month' },
            current_period_start: 1788220800,
            current_period_end: 1790812800,
          },
        ],
      },
    };
    retrieve.mockResolvedValue(live as never);
    const payload = JSON.stringify({
      id: 'evt_checkout_timeout',
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: row.subscription_id,
          customer: row.customer_id,
          client_reference_id: account,
        },
      },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    service.useProvider(adapter, {
      price_month: { planId: 'gardener', interval: 'month' },
    });
    await fixture.db.query()('subscriptions').update({ provider: 'stripe' });
    await expect(
      service.handleWebhook(Buffer.from(payload), signature),
    ).rejects.toThrow('fixture network timeout');
    expect(
      (await fixture.db.query()('billing_delivery_failures').first()).event_id,
    ).toBe('evt_checkout_timeout');
    expect(await fixture.db.query()('billing_events')).toHaveLength(0);
    await expect(
      service.handleWebhook(Buffer.from(payload), signature),
    ).resolves.toEqual({ handled: 'checkout.completed' });
    expect((await service.me(account)).plan.id).toBe('gardener');
    retrieve.mockRejectedValue(new Error('provider offline'));
    await expect(
      service.handleWebhook(Buffer.from(payload), signature),
    ).resolves.toEqual({ handled: 'duplicate' });
    expect(retrieve).toHaveBeenCalledTimes(2);
    const invalid = payload.replace('evt_checkout_timeout', 'evt_invalid');
    await expect(
      service.handleWebhook(Buffer.from(invalid), signature),
    ).rejects.toThrow('Webhook rejected');
    expect(
      await fixture.db
        .query()('billing_delivery_failures')
        .where({ event_id: 'evt_invalid' }),
    ).toHaveLength(0);
  });
});
