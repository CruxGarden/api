import { randomUUID } from 'node:crypto';
import { postgresFixture } from './support/postgres';
import { BillingRepository } from '../src/billing/billing.repository';
import { BillingService } from '../src/billing/billing.service';
import { BillingOperationsRepository } from '../src/billing/operations.repository';
import { BillingOperationsService } from '../src/billing/operations.service';
import { operationResult } from '../src/billing/operations';
import { MockBillingProvider } from '../src/billing/provider';
import { LoggerService } from '../src/common/services/logger.service';
import { Test } from '@nestjs/testing';
import { BillingController } from '../src/billing/billing.controller';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import request = require('supertest');

describe('durable billing operations', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let repo: BillingRepository;
  let operations: BillingOperationsRepository;
  let service: BillingService;
  let worker: BillingOperationsService;
  let provider: MockBillingProvider;
  const email = {
    deliveryMode: 'ses',
    send: jest.fn(async () => null),
  };
  const logger = new LoggerService();
  const home = randomUUID(),
    account = randomUUID();
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
    worker = new BillingOperationsService(
      service,
      operations,
      email as never,
      logger,
    );
  };
  beforeAll(async () => {
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_TRIAL_DAYS = '0';
    fixture = await postgresFixture();
    await fixture.db.query()('homes').insert({
      id: home,
      name: 'Operations fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await fixture.db.query()('accounts').insert({
      id: account,
      home_id: home,
      email: 'billing-ops@example.test',
      role: 'author',
    });
    repo = new BillingRepository(fixture.db, logger);
    operations = new BillingOperationsRepository(fixture.db, logger);
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      'billing_checkout_resolutions',
      'billing_notifications',
      'billing_delivery_failures',
      'billing_reconciliation',
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
    email.deliveryMode = 'ses';
    email.send.mockReset();
    email.send.mockResolvedValue(null);
    restart();
  });
  afterAll(async () => {
    process.env = { ...env };
    await fixture?.close();
  });
  const active = async () => {
    await service.checkout(account, 'gardener', 'month');
    return (await repo.byAccount(account)).data!;
  };

  it('reconciles a missed cancellation, survives restart and records verified state', async () => {
    const row = await active();
    provider.subscriptions.get(row.subscription_id!)!.status = 'canceled';
    restart();
    const result = await worker.sweep();
    expect(result.checked).toBe(1);
    expect(result.failed).toBe(0);
    expect((await service.me(account)).plan.id).toBe('free');
    expect(
      (
        await fixture.db
          .query()('billing_reconciliation')
          .where({ account_id: account })
          .first()
      ).verified_at,
    ).toBeTruthy();
    expect((await worker.health()).counters.failed).toBe(0);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('discovers, claims and delivers immediate work even when database default timestamps are ahead of the worker clock', async () => {
    // PostgreSQL timestamps have finer precision than JS Dates. Model the same
    // ordering failure deterministically with a database-default clock offset.
    for (const table of ['billing_reconciliation', 'billing_notifications'])
      await fixture.db
        .query()
        .raw(
          `ALTER TABLE ${table} ALTER COLUMN due_at SET DEFAULT (clock_timestamp() + interval '1 minute')`,
        );
    try {
      const row = await active();
      provider.subscriptions.get(row.subscription_id!)!.status = 'canceled';
      restart();
      expect((await worker.sweep()).checked).toBe(1);
      expect((await service.me(account)).plan.id).toBe('free');
      expect(email.send).toHaveBeenCalledTimes(1);
      // Direct first claim must use its caller's clock as well.
      await fixture.db.query()('billing_reconciliation').delete();
      expect(
        operationResult(await operations.claim(account, new Date())),
      ).toBeTruthy();
    } finally {
      for (const table of ['billing_reconciliation', 'billing_notifications'])
        await fixture.db
          .query()
          .raw(`ALTER TABLE ${table} ALTER COLUMN due_at SET DEFAULT now()`);
    }
  });

  it('coordinates replicas and rejects an old lease completion after recovery', async () => {
    await active();
    await operations.discover();
    const now = new Date();
    const [one, two] = await Promise.all([
      operations.claim(account, now),
      operations.claim(account, now),
    ]);
    expect([one.data, two.data].filter(Boolean)).toHaveLength(1);
    const old = one.data ?? two.data!;
    await fixture.db
      .query()('billing_reconciliation')
      .where({ account_id: account })
      .update({ lease_until: new Date(Date.now() - 1) });
    const current = operationResult(
      await operations.claim(account, new Date(), true),
    )!;
    expect(
      operationResult(await operations.finish(account, old, new Date(), null)),
    ).toBe(false);
    expect(
      operationResult(
        await operations.finish(account, current, new Date(), null),
      ),
    ).toBe(true);
  });

  it('keeps last verified state on failure, backs off and supports operator retry', async () => {
    await active();
    await worker.reconcile(account, true);
    const first = (
      await fixture.db
        .query()('billing_reconciliation')
        .where({ account_id: account })
        .first()
    ).verified_at;
    const fail = jest
      .spyOn(provider, 'fetchSubscription')
      .mockRejectedValueOnce(new Error('secret response must not escape'));
    expect((await worker.reconcile(account, true)).status).toBe('failed');
    const state = await worker.health();
    expect(state.counters.failed).toBe(1);
    expect(JSON.stringify(state)).not.toContain('secret response');
    const row = await fixture.db
      .query()('billing_reconciliation')
      .where({ account_id: account })
      .first();
    expect(row.verified_at).toEqual(first);
    expect(row.failures).toBe(1);
    expect(new Date(row.due_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect((await worker.reconcile(account, true)).status).toBe('verified');
    expect((await worker.health()).counters.failed).toBe(0);
    expect(fail).toHaveBeenCalled();
  });

  it('commits notices with the subscription, retries failed delivery across restart without losing paid access', async () => {
    await active();
    expect(email.send).not.toHaveBeenCalled();
    email.send.mockRejectedValueOnce(new Error('provider refused email'));
    await worker.deliverNotices();
    expect((await service.me(account)).plan.id).toBe('gardener');
    expect((await worker.health()).counters.failedNotifications).toBe(1);
    await fixture.db
      .query()('billing_notifications')
      .whereNull('sent_at')
      .update({ due_at: new Date(Date.now() - 1) });
    restart();
    expect(await worker.deliverNotices()).toBe(1);
    expect((await worker.health()).counters.pendingNotifications).toBe(0);
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('rolls back subscription success when saving its notification intent is refused', async () => {
    const enqueue = jest.spyOn(operations, 'enqueue').mockResolvedValueOnce({
      data: undefined,
      error: { message: 'fixture refusal' },
    } as never);
    await expect(active()).rejects.toThrow('operational state');
    expect((await repo.byAccount(account)).data).toBeNull();
    enqueue.mockRestore();
  });

  it('does not mark log-only email as sent and does not duplicate concurrent notice delivery', async () => {
    await active();
    email.deliveryMode = 'logging';
    expect(await worker.deliverNotices()).toBe(0);
    expect(email.send).not.toHaveBeenCalled();
    expect((await worker.health()).emailDelivery).toBe('logging');
    expect((await worker.health()).counters.failedNotifications).toBe(1);
    email.deliveryMode = 'ses';
    await fixture.db
      .query()('billing_notifications')
      .whereNull('sent_at')
      .update({ due_at: new Date(Date.now() - 1) });
    const other = new BillingOperationsService(
      service,
      operations,
      email as never,
      logger,
    );
    await Promise.all([worker.deliverNotices(), other.deliverNotices()]);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('warns once per actual trial end and sends payment failure discovered by reconciliation', async () => {
    const row = await active();
    await fixture.db.query()('billing_notifications').delete();
    const snap = provider.subscriptions.get(row.subscription_id!)!;
    snap.status = 'trialing';
    snap.trialEnd = new Date(Date.now() + 2 * 86400000);
    await worker.reconcile(account, true);
    restart();
    await worker.reconcile(account, true);
    expect(
      await fixture.db
        .query()('billing_notifications')
        .count({ n: '*' })
        .first(),
    ).toEqual({ n: '1' });
    snap.status = 'past_due';
    await worker.reconcile(account, true);
    const notices = await fixture.db
      .query()('billing_notifications')
      .select('subject');
    expect(notices.map((n) => n.subject)).toContain(
      'Crux Garden: your payment didn’t go through',
    );
  });

  it('suppresses queued trial and payment-failure notices after recovery or account closure', async () => {
    const row = await active();
    await fixture.db.query()('billing_notifications').delete();
    const snap = provider.subscriptions.get(row.subscription_id!)!;
    snap.status = 'trialing';
    snap.trialEnd = new Date(Date.now() + 2 * 86400000);
    await worker.reconcile(account, true);
    snap.status = 'past_due';
    await worker.reconcile(account, true);
    snap.status = 'active';
    await worker.reconcile(account, true);
    expect(await worker.deliverNotices()).toBe(0);
    expect(email.send).not.toHaveBeenCalled();
    expect(
      (
        await fixture.db.query()('billing_notifications').select('outcome')
      ).every((row) => row.outcome === 'superseded'),
    ).toBe(true);
    operationResult(
      await operations.enqueue(account, {
        subject: 'Closed account fixture',
        body: 'Fixture only',
      }),
    );
    await fixture.db
      .query()('accounts')
      .where({ id: account })
      .update({ deleted: new Date() });
    expect(await worker.deliverNotices()).toBe(0);
    expect((await worker.health()).counters.pendingNotifications).toBe(0);
  });

  it('records refused signed deliveries without secrets and clears failures on redelivery', async () => {
    const row = await active();
    const snap = provider.subscriptions.get(row.subscription_id!)!;
    provider.parseWebhook = async () => ({
      id: 'evt_recover',
      type: 'subscription.changed',
      subscription: { ...snap, priceId: 'missing_price' },
    });
    // The provider itself must confirm the unknown price; event arrival state is not authoritative.
    snap.priceId = 'missing_price';
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'fixture'),
    ).rejects.toThrow('price is not configured');
    expect((await worker.health()).counters.webhookFailures).toBe(1);
    snap.priceId = 'price_month';
    await service.handleWebhook(Buffer.from('{}'), 'fixture');
    expect((await worker.health()).counters.webhookFailures).toBe(0);
    expect(JSON.stringify((await worker.health()).problems)).not.toContain(
      'billing-ops@example.test',
    );
  });

  it('refuses unavailable database health instead of claiming an empty healthy system', async () => {
    jest.spyOn(operations, 'health').mockResolvedValueOnce({
      data: null,
      error: { message: 'fixture database refusal' },
    } as never);
    await expect(worker.health()).rejects.toThrow('operational state');
    jest.spyOn(repo, 'list').mockResolvedValueOnce({
      data: null,
      error: { message: 'fixture database refusal' },
    } as never);
    await expect(service.listAll()).rejects.toThrow('list is unavailable');
  });

  it('releases only the exact old absent attempt after an auditable operator review', async () => {
    const attempt = {
      id: randomUUID(),
      account_id: account,
      provider: 'mock',
      request: {
        accountId: account,
        email: 'fixture@example.test',
        customerId: null,
        priceId: 'price_month',
        successUrl: 'https://example.test/success',
        cancelUrl: 'https://example.test/cancel',
        trialDays: 0,
      },
      status: 'preparing' as const,
      session_id: null,
      session_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    operationResult(await repo.saveCheckoutAttempt(attempt));
    await expect(
      service.resolveAbsentCheckout(
        account,
        attempt.id,
        account,
        'req_provider_review',
      ),
    ).rejects.toThrow('exact old ambiguous');
    operationResult(
      await repo.saveCheckoutAttempt({
        ...attempt,
        created_at: new Date(Date.now() - 24 * 60 * 60_000),
      }),
    );
    await expect(
      service.resolveAbsentCheckout(
        account,
        randomUUID(),
        account,
        'req_provider_review',
      ),
    ).rejects.toThrow('exact old ambiguous');
    expect(
      (
        await service.resolveAbsentCheckout(
          account,
          attempt.id,
          account,
          'req_provider_review',
        )
      ).pendingCheckout,
    ).toBe(false);
    expect(
      await fixture.db
        .query()('billing_checkout_resolutions')
        .where({ attempt_id: attempt.id })
        .first(),
    ).toMatchObject({
      operator_id: account,
      review_reference: 'req_provider_review',
    });
    await service.checkout(account, 'gardener', 'month');
    expect((await service.me(account)).plan.id).toBe('gardener');
  });

  it('restricts operational and recovery endpoints to an authenticated admin with valid identifiers', async () => {
    const module = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        { provide: BillingService, useValue: service },
        { provide: BillingOperationsService, useValue: worker },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-role']) return false;
          req.account = { id: account, role: req.headers['x-role'] };
          return true;
        },
      })
      .compile();
    const app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(createRequestValidationPipe());
    await app.listen(0, '127.0.0.1');
    try {
      const server = app.getHttpServer();
      await request(server).get('/billing/operations').expect(403);
      await request(server)
        .post('/billing/checkout/resolve-absent')
        .set('x-role', 'author')
        .send({
          accountId: account,
          attemptId: randomUUID(),
          reviewReference: 'req_review',
          confirmation: 'provider-reviewed-no-checkout-or-subscription',
        })
        .expect(403);
      await request(server)
        .post('/billing/checkout/resolve-absent')
        .set('x-role', 'keeper')
        .send({
          accountId: account,
          attemptId: randomUUID(),
          reviewReference: 'req_review',
          confirmation: 'assumed-absent',
        })
        .expect(400);
      await request(server)
        .get('/billing/operations')
        .set('x-role', 'author')
        .expect(403);
      await request(server)
        .get('/billing/operations')
        .set('x-role', 'keeper')
        .expect(200);
      await request(server)
        .post('/billing/operations/reconcile')
        .set('x-role', 'keeper')
        .send({ accountId: 'bad' })
        .expect(400);
      await request(server)
        .post('/billing/checkout/recover')
        .set('x-role', 'author')
        .send({ accountId: account, sessionId: 'cs_test' })
        .expect(403);
      await request(server)
        .post('/billing/checkout/recover')
        .set('x-role', 'keeper')
        .send({ accountId: account, sessionId: 'https://evil.test' })
        .expect(400);
    } finally {
      await app.close();
    }
  });
});
