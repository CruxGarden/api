import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareBillingFixture,
  simulationAccountId as accountId,
} from '../../test/support/billing-simulation-host';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { sqliteGraphConfig } from '../common/database/sqlite-graph';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { MockBillingProvider } from './provider';

/** Actual durable repository and service; provider and email are isolated fixtures. */
describe('billing lifecycle persistence', () => {
  let directory: string;
  let db: DbService;
  let repository: BillingRepository;
  let service: BillingService;
  let provider: MockBillingProvider;
  const logger = new LoggerService();
  const env = { ...process.env };
  const open = async () => {
    db = new DbService(
      logger,
      sqliteGraphConfig(join(directory, 'billing.db')),
    );
    await db.onModuleInit();
    repository = new BillingRepository(db, logger);
    service = new BillingService(repository, logger, {
      send: jest.fn(),
    } as never);
    service.useProvider(provider, {
      price_month: { planId: 'gardener', interval: 'month' },
      price_year: { planId: 'gardener', interval: 'year' },
    });
  };
  beforeEach(async () => {
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_TRIAL_DAYS = '0';
    directory = mkdtempSync(join(tmpdir(), 'crux-billing-lifecycle-'));
    provider = new MockBillingProvider();
    await open();
    await prepareBillingFixture(db);
    await db.query().schema.createTable('billing_events', (t) => {
      t.text('id').primary();
      t.text('provider');
      t.text('type');
      t.uuid('account_id');
      t.text('payload');
    });
    await service.checkout(accountId, 'gardener', 'month');
  });
  afterEach(async () => {
    process.env = { ...env };
    await db.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists a missed cancellation across restart, then protects a replacement from old events', async () => {
    const old = (await repository.byAccount(accountId)).data!;
    const canceled = {
      ...provider.subscriptions.get(old.subscription_id!)!,
      status: 'canceled' as const,
    };
    provider.subscriptions.set(canceled.subscriptionId, canceled);
    expect((await service.sync(accountId)).plan.id).toBe('free');
    await db.onModuleDestroy();
    await open();
    expect(await service.me(accountId)).toMatchObject({
      status: 'canceled',
      plan: { id: 'free' },
    });
    await service.checkout(accountId, 'gardener', 'year');
    const replacement = (await repository.byAccount(accountId)).data!;
    expect(replacement.subscription_id).not.toBe(old.subscription_id);
    provider.emit({
      id: 'evt_old_deletion',
      type: 'subscription.deleted',
      subscription: canceled,
    });
    await service.handleWebhook(Buffer.from('{}'), 'fixture');
    provider.emit({
      id: 'evt_old_invoice',
      type: 'payment.failed',
      customerId: canceled.customerId,
      subscriptionId: canceled.subscriptionId,
    });
    await service.handleWebhook(Buffer.from('{}'), 'fixture');
    await db.onModuleDestroy();
    await open();
    expect((await repository.byAccount(accountId)).data).toMatchObject({
      status: 'active',
      subscription_id: replacement.subscription_id,
      interval: 'year',
    });
  });

  it('refuses and retries a payment event after an actual database write failure', async () => {
    const row = (await repository.byAccount(accountId)).data!;
    const event = {
      id: 'evt_write_refusal',
      type: 'payment.failed' as const,
      customerId: row.customer_id!,
      subscriptionId: row.subscription_id!,
    };
    await db
      .query()
      .raw(
        "CREATE TRIGGER refuse_payment BEFORE UPDATE ON subscriptions WHEN NEW.status = 'past_due' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END",
      );
    provider.emit(event);
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'fixture'),
    ).rejects.toThrow('Could not save payment status');
    expect((await service.me(accountId)).status).toBe('active');
    expect(
      await db.query()('billing_events').where({ id: event.id }),
    ).toHaveLength(0);
    await db.query().raw('DROP TRIGGER refuse_payment');
    provider.emit(event);
    expect(await service.handleWebhook(Buffer.from('{}'), 'fixture')).toEqual({
      handled: 'payment.failed',
    });
    expect((await service.me(accountId)).status).toBe('past_due');
    expect(
      await db.query()('billing_events').where({ id: event.id }),
    ).toHaveLength(1);
  });
});
