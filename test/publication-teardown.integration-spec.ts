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
describe('Publication teardown and retry', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  const home = randomUUID(),
    account = randomUUID(),
    author = randomUUID();
  const files = { deleteByPrefix: jest.fn(), invalidateCache: jest.fn() };
  const buckets = { deleteBucket: jest.fn() };
  const edge = new MockEdgeProvider();
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
  function teardown(id: string, action: string) {
    const r = request(app.getHttpServer());
    return (
      action === 'delete'
        ? r.delete(`/cruxes/${id}`)
        : r.post(`/cruxes/${id}/unpublish`)
    ).set('Authorization', `Bearer ${token()}`);
  }
  it.each(['delete', 'unpublish'])(
    '%s removes both storage layouts, domain routing and billing before removing the record',
    async (action) => {
      const { id, domain } = await seed();
      await teardown(id, action).expect(action === 'delete' ? 204 : 200);
      expect(files.deleteByPrefix).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: `${id}/` }),
      );
      expect(buckets.deleteBucket).toHaveBeenCalledWith(id);
      expect(files.invalidateCache).toHaveBeenCalledWith({
        paths: [`/${id}/*`],
      });
      expect(removeTenant).toHaveBeenCalledWith(`tenant-${id}`);
      const db = fixture.db.query();
      expect(
        await db('cruxes').where({ id }).whereNull('deleted').first(),
      ).toBeUndefined();
      expect(
        await db('usage_storage').where({ crux_id: id }).first(),
      ).toBeUndefined();
      expect(
        await db('custom_domains')
          .where({ id: domain })
          .whereNull('deleted')
          .first(),
      ).toBeUndefined();
      await request(app.getHttpServer())
        .get(`/cruxes/${id}`)
        .set('Authorization', `Bearer ${token()}`)
        .expect(404);
    },
  );
  it.each(
    ['delete', 'unpublish'].flatMap((action) =>
      ['static', 'bucket', 'domain', 'cache'].map((failure) => [
        action,
        failure,
      ]),
    ),
  )(
    '%s reports %s failure and preserves the owner record for a successful retry',
    async (action, failure) => {
      const { id } = await seed();
      const fail = {
        static: files.deleteByPrefix,
        bucket: buckets.deleteBucket,
        domain: removeTenant,
        cache: files.invalidateCache,
      }[failure]!;
      fail.mockRejectedValueOnce(new Error('External cleanup refused'));
      await teardown(id, action).expect(500);
      const db = fixture.db.query();
      expect(
        await db('cruxes').where({ id }).whereNull('deleted').first(),
      ).toBeDefined();
      expect(
        await db('usage_storage').where({ crux_id: id }).first(),
      ).toBeDefined();
      await teardown(id, action).expect(action === 'delete' ? 204 : 200);
      expect(
        await db('cruxes').where({ id }).whereNull('deleted').first(),
      ).toBeUndefined();
      expect(
        await db('usage_storage').where({ crux_id: id }).first(),
      ).toBeUndefined();
    },
  );
});
