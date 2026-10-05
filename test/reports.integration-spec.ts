import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { AppModule, TOO_MANY_REQUESTS } from '../src/app.module';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';
import { EmailService } from '../src/common/services/email.service';
import { StoreService } from '../src/common/services/store.service';
import { PublishStorageService } from '../src/common/services/publish-storage.service';
import { DomainsService } from '../src/domains/domains.service';
import { MockEdgeProvider } from '../src/domains/edge-provider';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { CRUX_TAKEN_DOWN } from '../src/crux/crux.service';
import { NOT_PUBLISHED } from '../src/report/report.service';
import { MockRedisService } from './mocks/redis.mock';
import { MockEmailService } from './mocks/email.mock';
import { postgresFixture } from './support/postgres';

/**
 * Reports, takedowns and the sitemap over real HTTP, guards, services and
 * PostgreSQL (the real migrations). Only storage, email, Redis and the CDN
 * are fixtures. Order matters in the first block: the public route admits
 * five requests a minute from one address.
 */
describe('Reports, takedowns and sitemap', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  const home = randomUUID(),
    ownerAccount = randomUUID(),
    author = randomUUID(),
    operator = randomUUID();
  const files = { deleteByPrefix: jest.fn(), invalidateCache: jest.fn() };
  const buckets = { deleteBucket: jest.fn() };
  const email = new MockEmailService();
  const env = { ...process.env };
  const bearer = (id: string, role: string) =>
    `Bearer ${jwt.sign({ id, email: `${role}@example.com`, role }, process.env.JWT_SECRET)}`;
  const asOperator = () => bearer(operator, 'admin');
  const asOwner = () => bearer(ownerAccount, 'author');
  const http = () => request(app.getHttpServer());
  const db = () => fixture.db.query();

  async function seedCrux(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db()('cruxes').insert({
      id,
      author_id: author,
      home_id: home,
      slug: `crux-${id}`,
      title: 'Published',
      type: 'webapp',
      data: '',
      status: 'living',
      visibility: 'public',
      discoverable: true,
      meta: { publishedAt: new Date().toISOString(), publishedVersion: 1 },
      ...overrides,
    });
    return id;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = 'reports-fixture-secret-reports-fixture';
    process.env.BASE_URL = 'https://api.example.test';
    process.env.PUBLIC_WEB_URL = 'https://garden.example.test/';
    process.env.PUBLISH_REVISION_ROUTING = '1';
    fixture = await postgresFixture();
    await db()('homes').insert({
      id: home,
      name: 'Fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await db()('accounts').insert([
      {
        id: ownerAccount,
        email: 'owner@example.com',
        role: 'author',
        home_id: home,
      },
      {
        id: operator,
        email: 'operator@example.com',
        role: 'admin',
        home_id: home,
      },
    ]);
    await db()('authors').insert({
      id: author,
      account_id: ownerAccount,
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
      .useValue(email)
      .overrideProvider(StoreService)
      .useValue(files)
      .overrideProvider(PublishStorageService)
      .useValue(buckets)
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    app.get(DomainsService).useProviders(new MockEdgeProvider(), {
      cnameTargets: async () => [],
      txtValues: async () => [],
      addresses: async () => [],
    });
    await app.listen(0, '127.0.0.1');
  }, 90000);
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
    process.env = env;
  });
  beforeEach(() => {
    files.deleteByPrefix.mockReset().mockResolvedValue(1);
    files.invalidateCache.mockReset().mockResolvedValue(undefined);
    buckets.deleteBucket.mockReset().mockResolvedValue(undefined);
    email.clear();
  });

  describe('POST /explore/reports', () => {
    let published: string;
    beforeAll(async () => {
      published = await seedCrux();
    });

    it('rejects a malformed report', async () => {
      const response = await http()
        .post('/explore/reports')
        .send({ cruxId: 'not-a-uuid', reason: 'rude', email: 'nope', x: 1 })
        .expect(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([
          'property x should not exist',
          'cruxId must be a UUID',
          'email must be an email',
        ]),
      );
    });

    it('404s for an unknown crux and for one that is not published', async () => {
      const draft = await seedCrux({ meta: {} });
      for (const cruxId of [randomUUID(), draft]) {
        const response = await http()
          .post('/explore/reports')
          .send({ cruxId, reason: 'spam' })
          .expect(404);
        expect(response.body.message).toBe(NOT_PUBLISHED);
      }
      expect(await db()('reports').count({ n: '*' }).first()).toEqual({
        n: '0',
      });
    });

    it('stores an open report without the raw address and tells the operator', async () => {
      process.env.REPORTS_NOTIFY_EMAIL = 'abuse@example.com';
      const response = await http()
        .post('/explore/reports')
        .send({
          cruxId: published,
          reason: 'copyright',
          details: 'This is my photograph.',
          email: 'Reporter@Example.com',
        })
        .expect(201);
      expect(response.body).toEqual({ ok: true });

      const [row] = await db()('reports').where({ crux_id: published });
      expect(row).toMatchObject({
        reason: 'copyright',
        details: 'This is my photograph.',
        reporter_email: 'reporter@example.com',
        status: 'open',
        author_id: author,
        crux_title: 'Published',
        resolved_by: null,
      });
      expect(row.reporter_ip_hash).toMatch(/^[\w-]{22}$/);
      expect(JSON.stringify(row)).not.toContain('127.0.0.1');
      expect(email.getSentEmails()).toHaveLength(1);
      expect(email.getLastEmail()).toMatchObject({
        email: 'abuse@example.com',
      });
      expect(email.getLastEmail().body).toContain('This is my photograph.');
    });

    it('needs no account or optional fields; without an address the admin accounts hear', async () => {
      delete process.env.REPORTS_NOTIFY_EMAIL;
      delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      await http()
        .post('/explore/reports')
        .send({ cruxId: published, reason: 'other' })
        .expect(201, { ok: true });
      expect(email.getSentEmails()).toHaveLength(1);
      expect(email.getLastEmail()).toMatchObject({
        email: 'operator@example.com',
      });
    });

    it('refuses a sixth request in a minute from one address', async () => {
      const response = await http()
        .post('/explore/reports')
        .send({ cruxId: published, reason: 'spam' })
        .expect(429);
      expect(response.body.message).toBe(TOO_MANY_REQUESTS);
      expect(await db()('reports').count({ n: '*' }).first()).toEqual({
        n: '2',
      });
    });
  });

  describe('operator review', () => {
    it.each([
      ['get', '/admin/reports'],
      ['get', '/admin/reports/summary'],
      ['patch', `/admin/reports/${randomUUID()}`],
      ['get', '/admin/takedowns'],
      ['post', '/admin/takedowns'],
      ['delete', `/admin/takedowns/${randomUUID()}`],
    ])('%s %s is for operators only', async (method, path) => {
      await http()[method](path).expect(401);
      await http()[method](path).set('Authorization', asOwner()).expect(403);
    });

    it('lists reports by status in pages and records who dismissed one', async () => {
      const list = await http()
        .get('/admin/reports?status=open&perPage=1')
        .set('Authorization', asOperator())
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ status: 'open', reason: 'other' });
      expect(JSON.parse(list.headers.pagination)).toMatchObject({ total: 2 });
      await http()
        .get('/admin/reports?status=closed')
        .set('Authorization', asOperator())
        .expect(400);

      const dismissed = await http()
        .patch(`/admin/reports/${list.body[0].id}`)
        .set('Authorization', asOperator())
        .send({ status: 'dismissed', resolutionNote: 'Not a violation' })
        .expect(200);
      expect(dismissed.body).toMatchObject({
        status: 'dismissed',
        resolutionNote: 'Not a violation',
        resolvedBy: operator,
      });
      const open = await http()
        .get('/admin/reports?status=open')
        .set('Authorization', asOperator())
        .expect(200);
      expect(open.body).toHaveLength(1);
      const summary = await http()
        .get('/admin/reports/summary')
        .set('Authorization', asOperator())
        .expect(200);
      expect(summary.body).toEqual({
        open: 1,
        resolvedLast30d: 1,
        takenDown: 0,
      });
      await http()
        .patch(`/admin/reports/${randomUUID()}`)
        .set('Authorization', asOperator())
        .send({ status: 'resolved' })
        .expect(404);
    });
  });

  describe('takedown', () => {
    it('unpublishes through the ordinary path, closes the reports, and blocks the id until lifted', async () => {
      const [report] = await db()('reports').where({ status: 'open' });
      const id = report.crux_id;
      const taken = await http()
        .post('/admin/takedowns')
        .set('Authorization', asOperator())
        .send({
          cruxId: id,
          reason: 'Copyright complaint',
          reportId: report.id,
        })
        .expect(201);
      expect(taken.body).toMatchObject({
        cruxId: id,
        authorId: author,
        reason: 'Copyright complaint',
        reportId: report.id,
        createdBy: operator,
      });

      // The owner's unpublish path ran: storage torn down, the row removed.
      expect(buckets.deleteBucket).toHaveBeenCalledWith(id);
      expect(await db()('cruxes').where({ id }).first()).toBeUndefined();
      expect(
        await db()('reports').where({ id: report.id }).first(),
      ).toMatchObject({ status: 'resolved', resolved_by: operator });
      await http()
        .post('/explore/reports')
        .send({ cruxId: id, reason: 'spam' })
        .expect((res) => expect([404, 429]).toContain(res.status));

      // Publishing syncs the crux back by id first; that is refused…
      const resync = () =>
        http()
          .post('/cruxes')
          .set('Authorization', asOwner())
          .send({ id, slug: 'back-again', title: 'Back again' });
      const refused = await resync().expect(403);
      expect(refused.body.message).toBe(CRUX_TAKEN_DOWN);
      // …and so is the publish itself, should a row exist some other way.
      await seedCrux({ id, slug: 'row-exists', meta: {} });
      const publish = await http()
        .post(`/cruxes/${id}/publish`)
        .set('Authorization', asOwner())
        .expect(403);
      expect(publish.body.message).toBe(CRUX_TAKEN_DOWN);
      await db()('cruxes').where({ id }).delete();

      // Taking it down again is the same takedown, not a second one.
      await http()
        .post('/admin/takedowns')
        .set('Authorization', asOperator())
        .send({ cruxId: id, reason: 'Again' })
        .expect(201);
      const active = await http()
        .get('/admin/takedowns?active=true')
        .set('Authorization', asOperator())
        .expect(200);
      expect(active.body.map((t: { cruxId: string }) => t.cruxId)).toEqual([
        id,
      ]);

      const lifted = await http()
        .delete(`/admin/takedowns/${id}`)
        .set('Authorization', asOperator())
        .expect(200);
      expect(lifted.body).toMatchObject({ cruxId: id, liftedBy: operator });
      await http()
        .delete(`/admin/takedowns/${id}`)
        .set('Authorization', asOperator())
        .expect(404);
      await resync().expect(201);
    });
  });

  describe('GET /explore/sitemap.xml', () => {
    it('lists discoverable cruxes and their authors on the public website, cacheable for an hour', async () => {
      await db()('cruxes').delete();
      const listed = await seedCrux({ slug: 'listed' });
      await seedCrux({ slug: 'unlisted', discoverable: false });
      await seedCrux({ slug: 'private', visibility: 'private' });
      await seedCrux({ slug: 'gone', deleted: new Date() });
      await db()('cruxes')
        .where({ id: listed })
        .update({ updated: '2026-10-03T10:00:00Z' });

      const response = await http().get('/explore/sitemap.xml').expect(200);

      expect(response.headers['content-type']).toBe(
        'application/xml; charset=utf-8',
      );
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(response.text).toContain(
        '<url><loc>https://garden.example.test/owner</loc><lastmod>2026-10-03</lastmod></url>',
      );
      expect(response.text).toContain(
        '<url><loc>https://garden.example.test/owner/listed</loc><lastmod>2026-10-03</lastmod></url>',
      );
      expect(response.text.match(/<url>/g)).toHaveLength(2);
    });
  });
});
