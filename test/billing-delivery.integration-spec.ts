import { randomUUID } from 'node:crypto';
import { postgresFixture } from './support/postgres';
import { BillingRepository } from '../src/billing/billing.repository';
import { BillingService } from '../src/billing/billing.service';
import { MockBillingProvider } from '../src/billing/provider';
import { LoggerService } from '../src/common/services/logger.service';

/** Real production migrations, PostgreSQL locks/rollback and billing services.
 * Only payment-provider observations and email delivery are fixtures.
 */
describe('durable billing delivery', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let repository: BillingRepository;
  let service: BillingService;
  let provider: MockBillingProvider;
  const logger = new LoggerService();
  const home = randomUUID(),
    account = randomUUID();
  const email = { send: jest.fn(async () => null) };
  const env = { ...process.env };
  const body = Buffer.from('{}');
  beforeAll(async () => {
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_TRIAL_DAYS = '0';
    fixture = await postgresFixture();
    await fixture.db.query()('homes').insert({
      id: home,
      name: 'Billing fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await fixture.db.query()('accounts').insert({
      id: account,
      home_id: home,
      email: 'billing@example.test',
      role: 'author',
    });
    repository = new BillingRepository(fixture.db, logger);
  }, 60_000);
  beforeEach(async () => {
    await fixture.db.query()('billing_events').delete();
    await fixture.db.query()('subscriptions').delete();
    provider = new MockBillingProvider();
    service = new BillingService(repository, logger, email as never);
    service.useProvider(provider, {
      price_month: { planId: 'gardener', interval: 'month' },
    });
    await service.checkout(account, 'gardener', 'month');
    email.send.mockClear();
  });
  afterAll(async () => {
    process.env = { ...env };
    await fixture?.close();
  });
  const failureEvent = async (id: string) => {
    const row = (await repository.byAccount(account)).data!;
    provider.subscriptions.set(row.subscription_id!, {
      ...provider.subscriptions.get(row.subscription_id!)!,
      status: 'past_due',
    });
    return {
      id,
      type: 'payment.failed' as const,
      customerId: row.customer_id!,
      subscriptionId: row.subscription_id!,
    };
  };

  it('rolls back the projection and receipt when completion fails, then retries without premature email', async () => {
    const db = fixture.db.query();
    await db.raw(
      "CREATE FUNCTION refuse_billing_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload IS NOT NULL THEN RAISE EXCEPTION 'fixture receipt refusal'; END IF; RETURN NEW; END $$",
    );
    await db.raw(
      'CREATE TRIGGER refuse_billing_receipt BEFORE UPDATE ON billing_events FOR EACH ROW EXECUTE FUNCTION refuse_billing_receipt()',
    );
    const event = await failureEvent('evt_receipt_refusal');
    try {
      provider.emit(event);
      await expect(service.handleWebhook(body, 'fixture')).rejects.toThrow(
        'Could not complete billing event',
      );
      expect((await service.me(account)).status).toBe('active');
      expect(await db('billing_events')).toHaveLength(0);
      expect(email.send).not.toHaveBeenCalled();
    } finally {
      await db.raw('DROP TRIGGER refuse_billing_receipt ON billing_events');
      await db.raw('DROP FUNCTION refuse_billing_receipt()');
    }
    provider.emit(event);
    await expect(service.handleWebhook(body, 'fixture')).resolves.toEqual({
      handled: 'payment.failed',
    });
    expect((await service.me(account)).status).toBe('past_due');
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('rolls back an interrupted database connection and processes the redelivery', async () => {
    const event = await failureEvent('evt_interrupted');
    await expect(
      repository.forAccount(account, async () => {
        await repository.claimEvent(event.id, 'mock', event.type);
        await fixture.db
          .query()('subscriptions')
          .where({ account_id: account })
          .update({ status: 'past_due' });
        // Terminate this disposable transaction's own PostgreSQL connection.
        await fixture.db
          .query()
          .raw('SELECT pg_terminate_backend(pg_backend_pid())');
      }),
    ).rejects.toThrow();
    expect((await service.me(account)).status).toBe('active');
    expect(await fixture.db.query()('billing_events')).toHaveLength(0);
    provider.emit(event);
    await expect(service.handleWebhook(body, 'fixture')).resolves.toEqual({
      handled: 'payment.failed',
    });
  });

  it('recovers a historical incomplete claim and serializes simultaneous duplicate delivery', async () => {
    const event = await failureEvent('evt_orphan');
    await fixture.db
      .query()('billing_events')
      .insert({ id: event.id, provider: 'mock', type: event.type });
    provider.emit(event);
    provider.emit(event);
    const results = await Promise.all([
      service.handleWebhook(body, 'fixture'),
      service.handleWebhook(body, 'fixture'),
    ]);
    expect(results.map((r) => r.handled).sort()).toEqual([
      'duplicate',
      'payment.failed',
    ]);
    const receipts = await fixture.db.query()('billing_events');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].payload.type).toBe('payment.failed');
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('serializes fresh provider observations between Sync and a distinct webhook', async () => {
    const row = (await repository.byAccount(account)).data!;
    const active = provider.subscriptions.get(row.subscription_id!)!;
    const canceled = { ...active, status: 'canceled' as const };
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const fetch = jest
      .spyOn(provider, 'fetchSubscription')
      .mockImplementationOnce(async () => {
        enter();
        await blocked;
        return active;
      });
    const syncing = service.sync(account);
    await entered;
    provider.subscriptions.set(canceled.subscriptionId, canceled);
    provider.emit({
      id: 'evt_canceled_after_sync',
      type: 'subscription.changed',
      subscription: canceled,
    });
    const delivery = service.handleWebhook(body, 'fixture');
    release();
    await Promise.all([syncing, delivery]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await service.me(account)).toMatchObject({
      status: 'canceled',
      plan: { id: 'free' },
    });
  });

  it('does not replay a historical invoice failure after payment has recovered', async () => {
    const event = await failureEvent('evt_recovered');
    const current = provider.subscriptions.get(event.subscriptionId)!;
    provider.subscriptions.set(event.subscriptionId, {
      ...current,
      status: 'active',
    });
    provider.emit(event);
    await service.handleWebhook(body, 'fixture');
    expect((await service.me(account)).status).toBe('active');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('refuses an unmapped price without completing the receipt or changing entitlements', async () => {
    const row = (await repository.byAccount(account)).data!;
    const unknown = {
      ...provider.subscriptions.get(row.subscription_id!)!,
      priceId: 'price_not_configured',
    };
    provider.subscriptions.set(unknown.subscriptionId, unknown);
    provider.emit({
      id: 'evt_unknown_price',
      type: 'subscription.changed',
      subscription: unknown,
    });
    await expect(service.handleWebhook(body, 'fixture')).rejects.toThrow(
      'Subscription price is not configured',
    );
    expect(await fixture.db.query()('billing_events')).toHaveLength(0);
    expect((await repository.byAccount(account)).data!.price_id).toBe(
      'price_month',
    );
  });

  it('commits billing even when post-commit email delivery fails', async () => {
    const event = await failureEvent('evt_email_failure');
    email.send.mockRejectedValueOnce(new Error('email unavailable'));
    provider.emit(event);
    await expect(service.handleWebhook(body, 'fixture')).resolves.toEqual({
      handled: 'payment.failed',
    });
    provider.emit(event);
    await expect(service.handleWebhook(body, 'fixture')).resolves.toEqual({
      handled: 'duplicate',
    });
    expect((await service.me(account)).status).toBe('past_due');
  });
});
