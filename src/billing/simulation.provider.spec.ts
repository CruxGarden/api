import { createRequestValidationPipe } from '../common/validation/request-validation';
import { prepareBillingFixture } from '../../test/support/billing-simulation-host';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { BillingController } from './billing.controller';
import { AuthGuard } from '../common/guards/auth.guard';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { sqliteGraphConfig } from '../common/database/sqlite-graph';
import { BillingSimulationRepository } from './simulation.repository';
import { SimulationBillingProvider } from './simulation.provider';
import { BillingService } from './billing.service';
import { BillingRepository } from './billing.repository';
import { EmailService } from '../common/services/email.service';
import { up } from '../../db/migrations/20260923010000_billing_simulation';

const accountId = '82a31c44-1e81-4a4f-aa88-7c3e941c1565';

describe('persistent local billing simulation', () => {
  let dir: string;
  let db: DbService;
  let provider: SimulationBillingProvider;
  const logger = new LoggerService();
  const email = { send: jest.fn() } as unknown as EmailService;
  let service: BillingService;
  const env = { ...process.env };
  const open = async () => {
    db = new DbService(logger, sqliteGraphConfig(join(dir, 'api.db')));
    await db.onModuleInit();
    const repo = new BillingSimulationRepository(db, logger);
    provider = new SimulationBillingProvider(repo);
    service = new BillingService(
      new BillingRepository(db, logger),
      logger,
      email,
      repo,
    );
  };
  beforeEach(async () => {
    process.env.BILLING_PROVIDER = 'simulation';
    process.env.STRIPE_TRIAL_DAYS = '0';
    dir = mkdtempSync(join(tmpdir(), 'crux-billing-simulation-'));
    await open();
    await prepareBillingFixture(db);
  });
  afterEach(async () => {
    process.env = { ...env };
    jest.clearAllMocks();
    await db?.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });
  it('applies persistent simulation through the normal entitlement service, without emails', async () => {
    expect((await service.catalog()).instant).toBe(true);
    await service.checkout(accountId, 'gardener', 'month');
    expect(await service.planIdFor(accountId)).toBe('gardener');
    await service.simulate(accountId, 'payment_failed');
    expect((await service.me(accountId)).status).toBe('past_due');
    expect(await service.planIdFor(accountId)).toBe('gardener');
    expect(
      await service.planIdFor(accountId, new Date(Date.now() + 8 * 86400000)),
    ).toBe('free');
    await db.onModuleDestroy();
    await open();
    expect((await service.me(accountId)).status).toBe('past_due');
    await service.simulate(accountId, 'activate');
    expect(await service.planIdFor(accountId)).toBe('gardener');
    await service.simulate(accountId, 'cancel');
    expect(await service.planIdFor(accountId)).toBe('free');
    expect(email.send).not.toHaveBeenCalled();
  });
  it('serializes checkouts and rolls back provider changes when entitlement storage fails', async () => {
    const results = await Promise.allSettled([
      service.checkout(accountId, 'gardener', 'month'),
      service.checkout(accountId, 'gardener_plus', 'year'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const before = await service.me(accountId);
    await db
      .query()
      .raw(
        `CREATE TRIGGER reject_simulation BEFORE UPDATE ON subscriptions BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
      );
    await expect(service.simulate(accountId, 'cancel')).rejects.toThrow(
      'Could not save subscription',
    );
    await db.query().raw('DROP TRIGGER reject_simulation');
    expect(await service.sync(accountId)).toEqual(before);
  });

  it('refuses real billing records without changing them, and never treats simulation as Stripe', async () => {
    const repo = new BillingRepository(db, logger);
    await db.query()('subscriptions').insert({
      account_id: accountId,
      provider: 'stripe',
      customer_id: 'cus_real',
      plan_id: 'gardener',
      status: 'active',
    });
    const before = (await repo.byAccount(accountId)).data;
    await expect(
      service.checkout(accountId, 'gardener', 'year'),
    ).rejects.toThrow('separate simulation database');
    await expect(service.simulate(accountId, 'cancel')).rejects.toThrow(
      'separate simulation database',
    );
    expect((await repo.byAccount(accountId)).data).toEqual(before);
    await db.query()('subscriptions').where({ account_id: accountId }).delete();
    await service.checkout(accountId, 'gardener', 'year');
    service.useProvider({ ...provider, name: 'stripe' } as never);
    await expect(service.planIdFor(accountId)).rejects.toThrow(
      'separate simulation database',
    );
  });

  it('keeps accounts and independent API databases isolated and refuses external webhooks', async () => {
    const secondAccount = '9a6f96d1-8fe4-47a3-963c-724ee591229d';
    await db
      .query()('accounts')
      .insert({ id: secondAccount, email: 'second@example.test' });
    await service.checkout(accountId, 'gardener', 'month');
    await expect(service.simulate(secondAccount, 'cancel')).rejects.toThrow(
      'No simulated subscription',
    );
    expect(await service.planIdFor(secondAccount)).toBe('free');
    const row = (await new BillingRepository(db, logger).byAccount(accountId))
      .data;
    const other = new DbService(
      logger,
      sqliteGraphConfig(join(dir, 'other.db')),
    );
    try {
      await other.onModuleInit();
      await other
        .query()
        .schema.createTable('accounts', (t) => t.uuid('id').primary());
      await up(other.query());
      const otherProvider = new SimulationBillingProvider(
        new BillingSimulationRepository(other, logger),
      );
      expect(
        await otherProvider.fetchSubscription(row.subscription_id),
      ).toBeNull();
      expect(
        await otherProvider.fetchCustomerSubscription(row.customer_id),
      ).toBeNull();
      await expect(
        otherProvider.parseWebhook(Buffer.from('{}')),
      ).rejects.toThrow('External webhooks are disabled');
    } finally {
      await other.onModuleDestroy();
    }
  });

  it('offers validated simulation controls only to the authenticated operator on this API', async () => {
    const module = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: service }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-test-role']) return false;
          req.account = { id: accountId, role: req.headers['x-test-role'] };
          return true;
        },
      })
      .compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    // Keep one owned listener for the journey instead of letting Supertest
    // repeatedly open/close an ephemeral port between HTTP assertions.
    await app.listen(0, '127.0.0.1');
    try {
      const server = app.getHttpServer();
      await request(server)
        .post('/billing/simulation')
        .send({ action: 'cancel' })
        .expect(403);
      await request(server)
        .post('/billing/simulation')
        .set('x-test-role', 'member')
        .send({ action: 'cancel' })
        .expect(403);
      await request(server)
        .post('/billing/simulation')
        .set('x-test-role', 'keeper')
        .send({ action: 'invented' })
        .expect(400);
      await request(server)
        .post('/billing/checkout')
        .set('x-test-role', 'keeper')
        .send({ planId: 'gardener', interval: 'month' })
        .expect(200);
      const state = await request(server)
        .get('/billing/me')
        .set('x-test-role', 'keeper')
        .expect(200);
      expect(state.body.canSimulate).toBe(true);
      const changed = await request(server)
        .post('/billing/simulation')
        .set('x-test-role', 'keeper')
        .send({
          action: 'change_plan',
          planId: 'gardener_plus',
          interval: 'year',
        })
        .expect(200);
      expect(changed.body).toMatchObject({
        plan: { id: 'gardener_plus' },
        interval: 'year',
        canSimulate: true,
      });
      await request(server)
        .post('/billing/simulation')
        .set('x-test-role', 'keeper')
        .send({ action: 'cancel', accountId: 'someone-else' })
        .expect(400);
      const member = await request(server)
        .get('/billing/me')
        .set('x-test-role', 'member')
        .expect(200);
      expect(member.body.canSimulate).toBe(false);
      service.useProvider({ name: 'stripe' } as never);
      await request(server)
        .post('/billing/simulation')
        .set('x-test-role', 'keeper')
        .send({ action: 'cancel' })
        .expect(400);
    } finally {
      await app.close();
    }
  });

  it('uses synthetic prices even with Stripe configuration and requires production opt-in', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_fixture_never_used';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_never_used';
    process.env.STRIPE_PRICE_GARDENER_MONTHLY = 'price_live_fixture';
    process.env.STRIPE_USE_GARDENER_TEST_PRICES = '1';
    const repo = new BillingSimulationRepository(db, logger);
    const create = () =>
      new BillingService(
        new BillingRepository(db, logger),
        logger,
        email,
        repo,
      );
    const simulation = create();
    const catalog = await simulation.catalog();
    expect(catalog.provider).toBe('simulation');
    expect(
      catalog.plans
        .flatMap((p) => p.prices)
        .every((p) => p.priceId.startsWith('price_mock_')),
    ).toBe(true);
    process.env.NODE_ENV = 'production';
    delete process.env.BILLING_ALLOW_MOCK;
    expect(create).toThrow('requires BILLING_ALLOW_MOCK=1');
    process.env.BILLING_ALLOW_MOCK = '1';
    expect(create().providerName).toBe('simulation');
  });

  it('persists trial, unpaid, renewal and scheduled cancellation through ordinary sync', async () => {
    process.env.STRIPE_TRIAL_DAYS = '14';
    await service.checkout(accountId, 'gardener', 'month');
    expect((await service.me(accountId)).status).toBe('trialing');
    const initial = await service.simulate(accountId, 'activate');
    const renewed = await service.simulate(accountId, 'renew');
    expect(new Date(renewed.renewsAt).getTime()).toBeGreaterThan(
      new Date(initial.renewsAt).getTime(),
    );
    await service.simulate(accountId, 'unpaid');
    expect(await service.planIdFor(accountId)).toBe('free');
    expect((await service.sync(accountId)).status).toBe('unpaid');
    await service.simulate(accountId, 'activate');
    await service.simulate(accountId, 'cancel_at_period_end');
    await db.onModuleDestroy();
    await open();
    expect((await service.me(accountId)).cancelAtPeriodEnd).toBe(true);
    await service.simulate(accountId, 'renew');
    expect((await service.sync(accountId)).status).toBe('canceled');
    expect(await service.planIdFor(accountId)).toBe('free');
    await service.checkout(accountId, 'gardener_plus', 'year');
    expect((await service.me(accountId)).plan.id).toBe('gardener_plus');
  });

  it('preserves checkout and subscription state across a database/provider restart', async () => {
    const checkout = await provider.createCheckout({
      accountId,
      email: 'local@example.test',
      customerId: null,
      priceId: 'price_mock_gardener_month',
      successUrl:
        'http://localhost/billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://localhost/billing/cancel',
      trialDays: 0,
    });
    const session = await provider.fetchCheckoutSession(checkout.sessionId);
    expect(session.status).toBe('complete');
    const subscription = await provider.fetchSubscription(
      session.subscriptionId,
    );
    expect(subscription).toMatchObject({ accountId, status: 'active' });
    expect(subscription.currentPeriodEnd).toBeInstanceOf(Date);
    await db.onModuleDestroy();
    await open();
    expect(await provider.fetchCheckoutSession(checkout.sessionId)).toEqual(
      session,
    );
    expect(await provider.fetchSubscription(session.subscriptionId)).toEqual(
      subscription,
    );
    expect(
      await provider.fetchCustomerSubscription(session.customerId),
    ).toEqual(subscription);
  });
});
