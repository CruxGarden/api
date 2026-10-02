import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';
import { EmailService } from '../src/common/services/email.service';
import { StoreService as Files } from '../src/common/services/store.service';
import { UsageService } from '../src/usage/usage.service';
import { PublishedAuthService } from '../src/published-auth/published-auth.service';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { MockRedisService } from './mocks/redis.mock';
import { MockEmailService } from './mocks/email.mock';
import { postgresFixture } from './support/postgres';

/** Real HTTP + production PostgreSQL schema, Store and Function runner. Only email/Redis/S3 are fixtures. */
describe('Published visitor authentication', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  const redis = new MockRedisService();
  const email = new MockEmailService();
  const crux = randomUUID(),
    otherCrux = randomUUID(),
    home = randomUUID();
  const owner = randomUUID(),
    author = randomUUID(),
    other = randomUUID();
  const origin = `https://${crux}.publish.crux.garden`;
  const custom = 'https://visitor.example';
  const base = `/published-auth/${crux}`;
  const tokenKey = (token: string) =>
    'crux:published:' + createHash('sha256').update(token).digest('hex');
  const visitorHeaders = (token: string, from = origin) => ({
    Origin: from,
    Authorization: `Bearer ${token}`,
  });
  const ownerToken = () =>
    jwt.sign(
      {
        id: owner,
        email: 'owner@example.com',
        role: 'author',
        grantId: 'parent-grant',
      },
      process.env.JWT_SECRET,
    );
  const codeFromEmail = () =>
    email.getLastEmail().body.match(/pc_[A-Za-z0-9_-]+/)![0];
  async function login(from = origin, address = 'owner@example.com') {
    await app.get(PublishedAuthService).code(crux, from, address);
    return (
      await request(app.getHttpServer())
        .post(`${base}/login`)
        .set('Origin', from)
        .send({ email: address, code: codeFromEmail() })
        .expect(200)
    ).body;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = 'published-auth-integration-secret';
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
      id: owner,
      email: 'owner@example.com',
      role: 'author',
      home_id: home,
    });
    await db('authors').insert([
      {
        id: author,
        account_id: owner,
        username: 'owner',
        display_name: 'Owner',
        home_id: home,
      },
      {
        id: other,
        account_id: owner,
        username: 'another',
        display_name: 'Another',
        home_id: home,
      },
    ]);
    await db('cruxes').insert(
      [crux, otherCrux].map((id) => ({
        id,
        author_id: author,
        home_id: home,
        slug: id,
        title: 'Published',
        data: '',
        type: 'webapp',
        status: 'living',
        visibility: 'public',
        meta: {
          publishedAt: new Date().toISOString(),
          publishedVersion: 1,
          publishStorageId: id,
          publishLayout: 'shared',
        },
      })),
    );
    await db('custom_domains').insert({
      id: randomUUID(),
      crux_id: crux,
      author_id: author,
      hostname: 'visitor.example',
      status: 'active',
      token: 'fixture-domain',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(fixture.db)
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(EmailService)
      .useValue(email)
      .overrideProvider(Files)
      .useValue({
        download: async () => ({
          data: Buffer.from(
            'export default function(req,ctx) { ctx.log("owner-only log"); return ctx.visitor; }',
          ),
        }),
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    await app.listen(0, '127.0.0.1');
    await db('artifacts').insert(
      [crux, otherCrux].map((id) => ({
        id: randomUUID(),
        resource_id: id,
        resource_type: 'crux',
        author_id: author,
        home_id: home,
        type: 'artifact',
        kind: 'file',
        filename: 'visitor.js',
        mime_type: 'application/javascript',
        encoding: 'utf8',
        size: 100,
        meta: {
          path: 'functions/visitor.js',
          publishStorageId: id,
          publishLayout: 'shared',
        },
      })),
    );
    await redis.set(
      'crux:auth:grant:id:parent-grant',
      'owner@example.com',
      3600,
    );
  }, 90000);
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
  });

  it('signs in a new visitor, meters Store/Function work to the publisher, and never meters login', async () => {
    const usage = app.get(UsageService);
    const storeMeter = jest.spyOn(usage, 'noteStoreRequest');
    const functionMeter = jest.spyOn(usage, 'noteFunctionRun');
    const session = await login(origin, 'new-visitor@example.com');
    expect(session.visitor.username).toBeTruthy();
    expect(storeMeter).not.toHaveBeenCalled();
    expect(functionMeter).not.toHaveBeenCalled();
    const headers = visitorHeaders(session.accessToken);
    await request(app.getHttpServer())
      .put(`/store/${crux}/score`)
      .set(headers)
      .send({ value: 42, mode: 'protected' })
      .expect(200, { value: 42 });
    const read = await request(app.getHttpServer())
      .get(`/store/${crux}/score`)
      .set(headers)
      .expect(200);
    expect(read.body.value).toBe(42);
    const fn = await request(app.getHttpServer())
      .post(`/fn/${crux}/visitor`)
      .set(headers)
      .send({})
      .expect(200);
    expect(fn.body).toEqual({ id: session.visitor.id, isOwner: false });
    expect(fn.headers['x-crux-function-logs']).toBeUndefined();
    await usage.flushStoreCounts();
    const daily = await fixture.db
      .query()('usage_store_daily')
      .where({ crux_id: crux })
      .first();
    expect(daily.author_id).toBe(author);
    expect(Number(daily.reads)).toBe(1);
    expect(Number(daily.writes)).toBe(1);
    expect(Number(daily.fn_calls)).toBe(1);
    storeMeter.mockRestore();
    functionMeter.mockRestore();
  });

  it('refuses account administration, other Cruxes, forged origins, and owner Store listing', async () => {
    const session = await login();
    const headers = visitorHeaders(session.accessToken);
    for (const path of [
      '/auth/profile',
      `/store/${crux}`,
      `/store/${crux}/-/export`,
      `/fn/${crux}/secrets`,
    ])
      await request(app.getHttpServer()).get(path).set(headers).expect(403);
    await request(app.getHttpServer())
      .get(`/store/${crux}`)
      .set(visitorHeaders(ownerToken()))
      .expect(403);
    // Even with a forged first-party Origin, opaque visitor credentials are not account JWTs.
    await request(app.getHttpServer())
      .get('/auth/profile')
      .set(visitorHeaders(session.accessToken, 'https://crux.garden'))
      .expect(401);
    await request(app.getHttpServer())
      .get(`/store/${otherCrux}/score`)
      .set(headers)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/fn/${otherCrux}/visitor`)
      .set(headers)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .get(`/store/${crux}/score`)
      .set(visitorHeaders(session.accessToken, 'https://evil.example'))
      .expect(403);
    await request(app.getHttpServer())
      .get(`/store/${crux}/score`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put(`/store/${crux}/score`)
      .set(visitorHeaders(ownerToken()))
      .send({ value: 0 })
      .expect(403);
  });

  it('scopes codes and refresh tokens and rotates once; logout revokes every access token', async () => {
    await app.get(PublishedAuthService).code(crux, custom, 'owner@example.com');
    const code = codeFromEmail();
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'owner@example.com', code })
      .expect(401);
    await request(app.getHttpServer())
      .post(`${base}/login`)
      .set('Origin', origin)
      .send({ email: 'owner@example.com', code })
      .expect(401);
    const logged = await request(app.getHttpServer())
      .post(`${base}/login`)
      .set('Origin', custom)
      .send({ email: 'owner@example.com', code })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${base}/login`)
      .set('Origin', custom)
      .send({ email: 'owner@example.com', code })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/token')
      .send({ refreshToken: logged.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post(`${base}/token`)
      .set('Origin', origin)
      .send({ refreshToken: logged.body.refreshToken })
      .expect(403);
    const refreshed = await request(app.getHttpServer())
      .post(`${base}/token`)
      .set('Origin', custom)
      .send({ refreshToken: logged.body.refreshToken })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${base}/token`)
      .set('Origin', custom)
      .send({ refreshToken: logged.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .delete(`${base}/logout`)
      .set(visitorHeaders(refreshed.body.accessToken, custom))
      .expect(204);
    for (const token of [logged.body.accessToken, refreshed.body.accessToken])
      await request(app.getHttpServer())
        .get(`${base}/profile`)
        .set(visitorHeaders(token, custom))
        .expect(401);
    await request(app.getHttpServer())
      .post(`${base}/token`)
      .set('Origin', custom)
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(401);
  });

  it('requires exact registered origins and refuses sessions after unpublish or domain removal', async () => {
    for (const from of [
      custom + ':8443',
      custom + '/',
      'https://evil.example',
      'null',
    ])
      await expect(
        app.get(PublishedAuthService).code(crux, from, 'owner@example.com'),
      ).rejects.toThrow('origin');
    const session = await login(custom);
    await fixture.db
      .query()('custom_domains')
      .where({ hostname: 'visitor.example' })
      .update({ deleted: new Date() });
    await request(app.getHttpServer())
      .get(`${base}/profile`)
      .set(visitorHeaders(session.accessToken, custom))
      .expect(403);
    const regular = await login();
    await fixture.db.query()('cruxes').where({ id: crux }).update({ meta: {} });
    await request(app.getHttpServer())
      .get(`${base}/profile`)
      .set(visitorHeaders(regular.accessToken))
      .expect(403);
    await fixture.db
      .query()('cruxes')
      .where({ id: crux })
      .update({
        meta: {
          publishedAt: '2026-09-29',
          publishedVersion: 1,
          publishStorageId: crux,
          publishLayout: 'shared',
        },
      });
  });

  it('inherits the parent account with visitor authority, including owner deletion and function context', async () => {
    const result = await request(app.getHttpServer())
      .post(`${base}/session`)
      .set(visitorHeaders(ownerToken(), 'https://crux.garden'))
      .send({ origin })
      .expect(200);
    const headers = visitorHeaders(
      result.body.accessToken,
      'https://crux.garden',
    );
    const fn = await request(app.getHttpServer())
      .post(`/fn/${crux}/visitor`)
      .set(headers)
      .send({})
      .expect(200);
    expect(fn.body).toEqual({ id: author, isOwner: false });
    await fixture.db
      .query()('store')
      .insert(
        [author, other].map((id) => ({
          id: randomUUID(),
          crux_id: crux,
          author_id: author,
          visitor_id: id,
          key: 'private-slots',
          value: JSON.stringify(id),
          mode: 'protected',
        })),
      );
    await request(app.getHttpServer())
      .delete(`/store/${crux}/private-slots`)
      .set(headers)
      .expect(204);
    expect(
      (
        await fixture.db
          .query()('store')
          .where({ crux_id: crux, key: 'private-slots' })
      ).map((r) => r.visitor_id),
    ).toEqual([other]);
    await redis.del('crux:auth:grant:id:parent-grant');
    await request(app.getHttpServer())
      .get(`${base}/profile`)
      .set(headers)
      .expect(401);
  });

  it('expires access credentials and refreshes without giving them account authority', async () => {
    const session = await login();
    redis.getStore().get(tokenKey(session.accessToken))!.expiresAt =
      Date.now() - 1;
    await request(app.getHttpServer())
      .get(`${base}/profile`)
      .set(visitorHeaders(session.accessToken))
      .expect(401);
    await request(app.getHttpServer())
      .post(`${base}/token`)
      .set('Origin', origin)
      .send({ refreshToken: session.refreshToken })
      .expect(200);
  });

  it('blocks ordinary account login on published origins and limits code delivery independently of billing', async () => {
    await request(app.getHttpServer())
      .post('/auth/code')
      .set('Origin', origin)
      .send({ email: 'owner@example.com' })
      .expect(403);
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post(`${base}/code`)
        .set('Origin', origin)
        .send({ email: 'owner@example.com' })
        .expect(200);
    await request(app.getHttpServer())
      .post(`${base}/code`)
      .set('Origin', origin)
      .send({ email: 'owner@example.com' })
      .expect(429);
  });
});
