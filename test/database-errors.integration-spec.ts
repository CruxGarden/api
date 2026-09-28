import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/common/services/db.service';
import { LoggerService } from '../src/common/services/logger.service';
import { RedisService } from '../src/common/services/redis.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { MockRedisService } from './mocks/redis.mock';
import { postgresFixture } from './support/postgres';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const home = id(1),
  account = id(2),
  author = id(3),
  crux = id(4),
  secondCrux = id(5),
  dimension = id(6),
  artifact = id(7);

describe('database failures through production HTTP services', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let db: DbService;
  let authorization: string;
  const env = { ...process.env };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'database-errors-test-key';
    process.env.BASE_URL = 'https://api.example.test';
    process.env.NURSERY_MODE = 'false';
    fixture = await postgresFixture();
    db = fixture.db;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(db)
      .overrideProvider(RedisService)
      .useValue(new MockRedisService())
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    app.useGlobalFilters(new HttpExceptionFilter(new LoggerService()));
    await app.listen(0, '127.0.0.1');
    authorization = `Bearer ${jwt.sign({ id: account, role: 'author' }, process.env.JWT_SECRET)}`;
    await db.query()('homes').insert({
      id: home,
      name: 'Test host',
      primary: true,
      type: 'personal',
      kind: 'garden',
    });
    await db.query()('accounts').insert({
      id: account,
      email: 'alice@example.test',
      role: 'author',
      home_id: home,
    });
    await db.query()('authors').insert({
      id: author,
      username: 'alice',
      display_name: 'Alice',
      account_id: account,
      home_id: home,
    });
    await db
      .query()('cruxes')
      .insert(
        [crux, secondCrux].map((id, index) => ({
          id,
          slug: `crux-${index}`,
          title: 'Test Crux',
          data: '',
          type: 'living',
          kind: 'page',
          status: 'active',
          visibility: 'private',
          author_id: author,
          home_id: home,
        })),
      );
    await db.query()('dimensions').insert({
      id: dimension,
      source_id: crux,
      target_id: secondCrux,
      type: 'graft',
      author_id: author,
      home_id: home,
    });
    await db.query()('artifacts').insert({
      id: artifact,
      resource_id: crux,
      resource_type: 'crux',
      type: 'text',
      kind: 'file',
      filename: 'notes.txt',
      encoding: 'utf-8',
      mime_type: 'text/plain',
      size: 0,
      author_id: author,
      home_id: home,
    });
    // A real constraint collision below the repository, including after service prechecks.
    await db
      .query()
      .raw(
        `CREATE FUNCTION test_constraint_collision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO homes SELECT * FROM homes LIMIT 1; RETURN NEW; END $$`,
      );
  }, 90_000);
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await fixture?.close();
      process.env = env;
    }
  });

  it.each([
    ['authors', `/authors/${author}`],
    ['authors', '/authors/alice'],
    ['authors', '/authors/check-username?username=someone'],
    ['authors', '/authors/search?q=alice'],
    ['cruxes', `/cruxes/${crux}`],
    ['cruxes', '/cruxes/crux-0'],
    ['dimensions', `/dimensions/${dimension}`],
    ['accounts', '/account'],
    ['tags', `/cruxes/${crux}/tags`],
    ['store', `/store/${crux}/missing-key`],
    ['store', '/store/gardens/mine'],
  ])(
    'returns 500 for an unavailable %s table at %s, then recovers',
    async (table, url) => {
      await db.query().schema.renameTable(table, `${table}_unavailable`);
      try {
        const response = await request(app.getHttpServer())
          .get(url)
          .set('Authorization', authorization)
          .expect(500);
        expect(response.body.message).toBe('Internal server error');
        expect(response.body).not.toHaveProperty('stack');
        expect(JSON.stringify(response.body)).not.toMatch(
          /relation|select|unavailable/,
        );
      } finally {
        await db.query().schema.renameTable(`${table}_unavailable`, table);
      }
      await request(app.getHttpServer())
        .get(url)
        .set('Authorization', authorization)
        .expect(200);
    },
  );

  it.each([`/store/${crux}/missing-key`, `/fn/${crux}/missing-function`])(
    'does not downgrade a signed-in request to anonymous when identity lookup fails at %s',
    async (url) => {
      await db.query().schema.renameTable('authors', 'authors_unavailable');
      try {
        await request(app.getHttpServer())
          .get(url)
          .set('Authorization', authorization)
          .expect(500);
      } finally {
        await db.query().schema.renameTable('authors_unavailable', 'authors');
      }
    },
  );

  it('does not turn an anonymous Store read failure into a missing value', async () => {
    await db.query().schema.renameTable('store', 'store_unavailable');
    try {
      await request(app.getHttpServer())
        .get(`/store/${crux}/missing-key`)
        .expect(500);
    } finally {
      await db.query().schema.renameTable('store_unavailable', 'store');
    }
    const response = await request(app.getHttpServer())
      .get(`/store/${crux}/missing-key`)
      .expect(200);
    expect(response.body).toEqual({ value: null });
  });

  it('distinguishes an Artifact storage outage from an absent Artifact', async () => {
    await db.query().schema.renameTable('artifacts', 'artifacts_unavailable');
    try {
      await request(app.getHttpServer())
        .put(`/artifacts/${artifact}`)
        .set('Authorization', authorization)
        .send({ filename: 'renamed.txt' })
        .expect(500);
    } finally {
      await db.query().schema.renameTable('artifacts_unavailable', 'artifacts');
    }
    await request(app.getHttpServer())
      .put(`/artifacts/${id(999)}`)
      .set('Authorization', authorization)
      .send({ filename: 'renamed.txt' })
      .expect(404);
  });

  const writes = [
    {
      table: 'store',
      method: 'put',
      url: `/store/${crux}/new-key`,
      body: { value: 'changed', mode: 'protected' },
    },
    {
      table: 'accounts',
      method: 'patch',
      url: '/account',
      body: { email: 'changed@example.test' },
    },
    {
      table: 'authors',
      method: 'patch',
      url: `/authors/${author}`,
      body: { displayName: 'Changed' },
    },
    {
      table: 'cruxes',
      method: 'patch',
      url: `/cruxes/${crux}`,
      body: { title: 'Changed' },
    },
    {
      table: 'dimensions',
      method: 'patch',
      url: `/dimensions/${dimension}`,
      body: { note: 'Changed' },
    },
    {
      table: 'artifacts',
      method: 'put',
      url: `/artifacts/${artifact}`,
      body: { filename: 'changed.txt' },
    },
    {
      table: 'tags',
      method: 'put',
      url: `/cruxes/${crux}/tags`,
      body: { labels: ['changed'] },
    },
  ] as const;
  it.each(writes)(
    'reports a native unique violation from $table as 409 without changing rows',
    async ({ table, method, url, body }) => {
      const before = await db.query()(table).select('*');
      await db
        .query()
        .raw(
          `CREATE TRIGGER test_collision BEFORE INSERT OR UPDATE ON ?? FOR EACH ROW EXECUTE FUNCTION test_constraint_collision()`,
          [table],
        );
      try {
        const response = await request(app.getHttpServer())
          [method](url)
          .set('Authorization', authorization)
          .send(body)
          .expect(409);
        expect(response.body.message).toBe(
          'A record with these values already exists',
        );
        expect(JSON.stringify(response.body)).not.toMatch(
          /homes_pkey|duplicate key|INSERT/,
        );
        expect(await db.query()(table).select('*')).toEqual(before);
      } finally {
        await db.query().raw('DROP TRIGGER test_collision ON ??', [table]);
      }
    },
  );
});
