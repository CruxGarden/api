import { BillingService } from '../src/billing/billing.service';
import { MockBillingProvider } from '../src/billing/provider';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';
import { EmailService } from '../src/common/services/email.service';
import { StoreService } from '../src/common/services/store.service';
import { PublishStorageService } from '../src/common/services/publish-storage.service';
import { DomainsService } from '../src/domains/domains.service';
import { MockEdgeProvider } from '../src/domains/edge-provider';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { MockRedisService } from './mocks/redis.mock';
import { MockEmailService } from './mocks/email.mock';
import { postgresFixture } from './support/postgres';

/** Real HTTP/domain services and PostgreSQL. Only external storage, email, Redis and CDN are fixtures. */
describe('Hosted account closure and retry', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  const home = randomUUID(),
    account = randomUUID(),
    author = randomUUID();
  const files = {
    deleteByPrefix: jest.fn(),
    invalidateCache: jest.fn(),
    download: jest.fn(async () => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }),
    delete: jest.fn(),
  };
  const buckets = { deleteBucket: jest.fn() };
  const edge = new MockEdgeProvider();
  const billingProvider = new MockBillingProvider();
  const removeTenant = jest.spyOn(edge, 'deleteTenant');
  const token = () =>
    jwt.sign(
      { id: account, email: 'owner@example.com', role: 'author' },
      process.env.JWT_SECRET,
    );
  const previousSecret = process.env.JWT_SECRET;
  beforeAll(async () => {
    process.env.JWT_SECRET = 'publication-teardown-fixture-secret';
    fixture = await postgresFixture();
    const db = fixture.db.query();
    await db('homes').insert({
      id: home,
      name: 'Fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await db('accounts').insert({
      id: account,
      email: 'owner@example.com',
      role: 'author',
      home_id: home,
    });
    await db('authors').insert({
      id: author,
      account_id: account,
      username: 'owner',
      display_name: 'Owner',
      home_id: home,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(fixture.db)
      .overrideProvider(RedisService)
      .useValue(new MockRedisService())
      .overrideProvider(EmailService)
      .useValue(new MockEmailService())
      .overrideProvider(StoreService)
      .useValue(files)
      .overrideProvider(PublishStorageService)
      .useValue(buckets)
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    app.get(DomainsService).useProviders(edge, {
      cnameTargets: async () => [],
      txtValues: async () => [],
      addresses: async () => [],
    });
    app.get(BillingService).useProvider(billingProvider, {
      price_month: { planId: 'gardener', interval: 'month' },
    });
    await app.listen(0, '127.0.0.1');
  }, 90000);
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  beforeEach(() => {
    files.deleteByPrefix.mockReset().mockResolvedValue(1);
    files.invalidateCache.mockReset().mockResolvedValue(undefined);
    buckets.deleteBucket.mockReset().mockResolvedValue(undefined);
    removeTenant.mockReset().mockResolvedValue('deleted');
  });
  async function seed() {
    const id = randomUUID(),
      domain = randomUUID();
    const db = fixture.db.query();
    await db('cruxes').insert({
      id,
      author_id: author,
      home_id: home,
      slug: id,
      title: 'Published',
      type: 'webapp',
      data: '',
      status: 'living',
      visibility: 'public',
      meta: { publishedAt: new Date().toISOString(), publishedVersion: 1 },
    });
    await db('custom_domains').insert({
      id: domain,
      crux_id: id,
      author_id: author,
      hostname: `${id}.example.com`,
      status: 'active',
      token: 'fixture',
      tenant_id: `tenant-${id}`,
    });
    await db('usage_storage').insert({
      crux_id: id,
      author_id: author,
      bytes: 50,
      files: 1,
    });
    return { id, domain };
  }
  it('keeps the account on cleanup failure; retry removes publication, backup, and old-token access', async () => {
    const { id, domain } = await seed();
    await app.get(BillingService).checkout(account, 'gardener', 'month');
    await app.get(BillingService).sync(account);
    const subscription = await fixture.db
      .query()('subscriptions')
      .where({ account_id: account })
      .first();
    expect(subscription.status).not.toBe('canceled');
    const authorization = `Bearer ${token()}`;
    const close = () =>
      request(app.getHttpServer())
        .delete('/account')
        .set('Authorization', authorization)
        .send({ confirmationText: 'DELETE MY ACCOUNT' });
    await request(app.getHttpServer())
      .get('/account/closure')
      .set('Authorization', authorization)
      .expect(200, { version: 1, confirmationText: 'DELETE MY ACCOUNT' });
    files.deleteByPrefix.mockRejectedValueOnce(new Error('storage outage'));
    await close().expect(500);
    expect(
      (await fixture.db.query()('accounts').where({ id: account }).first())
        .deleted,
    ).toBeNull();
    await close().expect(204);
    expect(
      (await billingProvider.fetchSubscription(subscription.subscription_id))
        ?.status,
    ).toBe('canceled');
    expect(files.deleteByPrefix).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: `sync/${account}/` }),
    );
    expect(files.invalidateCache).toHaveBeenCalledWith({ paths: [`/${id}/*`] });
    expect(removeTenant).toHaveBeenCalledWith(`tenant-${id}`);
    expect(
      (await fixture.db.query()('accounts').where({ id: account }).first())
        .deleted,
    ).not.toBeNull();
    expect(
      (await fixture.db.query()('authors').where({ id: author }).first())
        .deleted,
    ).not.toBeNull();
    expect(
      (await fixture.db.query()('cruxes').where({ id }).first()).deleted,
    ).not.toBeNull();
    expect(
      (await fixture.db.query()('custom_domains').where({ id: domain }).first())
        .deleted,
    ).not.toBeNull();
    await request(app.getHttpServer())
      .get('/account')
      .set('Authorization', authorization)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/authors/owner/cruxes/${id}`)
      .expect(404);
  });
});
