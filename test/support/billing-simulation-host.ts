import { up as checkoutSchema } from '../../db/migrations/20261001010000_billing_checkout_attempts';
/** Test-only HTTP fixture: real billing controller/service/repositories + disposable SQLite.
 * Authentication and unrelated API routes are synthetic. Never loaded by AppModule.
 */
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { request as proxyRequest } from 'http';
import { BillingController } from '../../src/billing/billing.controller';
import { BillingService } from '../../src/billing/billing.service';
import { BillingRepository } from '../../src/billing/billing.repository';
import { BillingSimulationRepository } from '../../src/billing/simulation.repository';
import { DbService } from '../../src/common/services/db.service';
import { LoggerService } from '../../src/common/services/logger.service';
import { EmailService } from '../../src/common/services/email.service';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { sqliteGraphConfig } from '../../src/common/database/sqlite-graph';
import { up } from '../../db/migrations/20260923010000_billing_simulation';

export const simulationAccountId = '82a31c44-1e81-4a4f-aa88-7c3e941c1565';

export async function prepareBillingFixture(db: DbService) {
  if (await db.query().schema.hasTable('accounts')) return;
  await db.query().schema.createTable('accounts', (t) => {
    t.uuid('id').primary();
    t.text('email');
    t.timestamp('deleted');
  });
  await db
    .query()('accounts')
    .insert({ id: simulationAccountId, email: 'local@example.test' });
  await up(db.query());
  await checkoutSchema(db.query());
  await db.query().schema.createTable('subscriptions', (t) => {
    t.uuid('account_id').primary();
    t.text('provider').notNullable().defaultTo('stripe');
    for (const key of [
      'customer_id',
      'subscription_id',
      'price_id',
      'interval',
      'pending_session_id',
    ])
      t.text(key);
    t.text('plan_id').notNullable().defaultTo('free');
    t.text('status').notNullable().defaultTo('none');
    t.boolean('cancel_at_period_end').notNullable().defaultTo(false);
    for (const key of [
      'current_period_start',
      'current_period_end',
      'trial_end',
      'past_due_since',
      'updated',
    ])
      t.timestamp(key);
  });
}

async function main() {
  const [filename, fallback, port = '0'] = process.argv.slice(2);
  if (!filename || !fallback || new URL(fallback).hostname !== '127.0.0.1')
    throw new Error('Disposable database and loopback mock required');
  process.env.NODE_ENV = 'test';
  process.env.BILLING_PROVIDER = 'simulation';
  process.env.STRIPE_TRIAL_DAYS = '0';
  const logger = new LoggerService();
  const db = new DbService(logger, sqliteGraphConfig(filename));
  await db.onModuleInit();
  await prepareBillingFixture(db);
  const email = {
    send: () => {
      throw new Error('Billing simulation must not send email');
    },
  } as unknown as EmailService;
  const service = new BillingService(
    new BillingRepository(db, logger),
    logger,
    email,
    new BillingSimulationRepository(db, logger),
  );
  const module = await Test.createTestingModule({
    controllers: [BillingController],
    providers: [{ provide: BillingService, useValue: service }],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        const req = context.switchToHttp().getRequest();
        if (req.headers.authorization !== 'Bearer test-access') return false;
        req.account = { id: simulationAccountId, role: 'keeper' };
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  app.enableCors();
  app.use((req, res, next) => {
    if (req.url.startsWith('/billing/')) return next();
    const upstream = proxyRequest(
      new URL(req.url, fallback),
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(fallback).host },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.listen(Number(port), '127.0.0.1');
  process.send?.({ url: await app.getUrl() });
  process.once('SIGTERM', async () => {
    await app.close();
    await db.onModuleDestroy();
    process.exit(0);
  });
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
