import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/common/services/db.service';
import { LoggerService } from '../src/common/services/logger.service';
import { RedisService } from '../src/common/services/redis.service';
import { sqliteGraphConfig } from '../src/common/database/sqlite-graph';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { MockRedisService } from './mocks/redis.mock';

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error('A refused request must never open a model client');
  }),
}));

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const privateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const publicId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const unlistedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** Real HTTP, guards, services and SQL repositories; no network services or live database. */
describe('Crux access policy', () => {
  let app: INestApplication;
  let db: DbService;
  const token = (author: string) =>
    `Bearer ${jwt.sign({ id: `account-${author}`, role: 'author' }, process.env.JWT_SECRET)}`;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'access-policy-test-secret';
    process.env.BASE_URL = 'http://localhost';
    db = new DbService(new LoggerService(), sqliteGraphConfig(':memory:'));
    const sql = db.query();
    // Only columns used by these hosted routes. No desktop profile or schema migration.
    await sql.schema.createTable('authors', (t) => {
      t.string('id').primary();
      t.string('account_id');
      t.string('username');
      t.string('display_name');
      t.string('root_id');
      t.string('home_id');
      t.timestamp('deleted');
      t.timestamp('updated');
    });
    await sql.schema.createTable('cruxes', (t) => {
      t.string('id').primary();
      t.string('author_id');
      t.string('slug');
      t.string('title');
      t.string('visibility');
      t.string('type');
      t.string('status');
      t.string('data');
      t.timestamp('created');
      t.json('meta');
      t.timestamp('deleted');
    });
    await sql.schema.createTable('dimensions', (t) => {
      t.string('id').primary();
      t.string('source_id');
      t.string('target_id');
      t.string('type');
      t.string('author_id');
      t.timestamp('created');
      t.timestamp('deleted');
    });
    await sql.schema.createTable('artifacts', (t) => {
      t.string('id').primary();
      t.string('resource_id');
      t.string('resource_type');
      t.string('author_id');
      t.string('kind');
      t.string('type');
      t.string('filename');
      t.string('encoding');
      t.string('mime_type');
      t.integer('size');
      t.json('meta');
      t.timestamp('updated');
      t.timestamp('created');
      t.timestamp('deleted');
    });
    await sql.schema.createTable('tags', (t) => {
      t.string('id').primary();
      t.string('resource_id');
      t.string('resource_type');
      t.string('label');
      t.timestamp('deleted');
    });
    await sql('authors').insert([
      {
        id: alice,
        account_id: `account-${alice}`,
        username: 'alice',
        root_id: privateId,
      },
      { id: bob, account_id: `account-${bob}`, username: 'bob' },
    ]);
    await sql('cruxes').insert(
      [
        {
          id: privateId,
          author_id: alice,
          slug: 'same-slug',
          visibility: 'private',
        },
        {
          id: publicId,
          author_id: alice,
          slug: 'published',
          visibility: 'public',
        },
        {
          id: unlistedId,
          author_id: alice,
          slug: 'unlisted',
          visibility: 'unlisted',
        },
        { id: bobId, author_id: bob, slug: 'same-slug', visibility: 'private' },
      ].map((row) => ({
        ...row,
        title: row.slug,
        type: 'markdown',
        status: 'living',
        meta: {
          systemPrompt: 'private prompt',
          projectFolder: '/private/work',
          summary: 'Shared summary',
        },
      })),
    );
    await sql('artifacts').insert({
      id: 'alice-file',
      resource_id: privateId,
      resource_type: 'crux',
      author_id: alice,
      kind: 'file',
      type: 'text',
      filename: 'notes.txt',
      mime_type: 'text/plain',
      size: 12,
    });
    await sql('dimensions').insert([
      {
        author_id: alice,
        id: 'private-link',
        source_id: publicId,
        target_id: privateId,
        type: 'graft',
      },
      {
        author_id: alice,
        id: 'unlisted-link',
        source_id: publicId,
        target_id: unlistedId,
        type: 'graft',
      },
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DbService)
      .useValue(db)
      .overrideProvider(RedisService)
      .useValue(new MockRedisService())
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    // One listener per fixture; Supertest must not reopen it for each request.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    '',
    '/dimensions',
    '/tags',
    '/artifacts',
    '/artifacts/secret/download',
  ])(
    'refuses another account on /cruxes/:id%s before reading content',
    async (suffix) => {
      await request(app.getHttpServer())
        .get(`/cruxes/${privateId}${suffix}`)
        .set('Authorization', token(bob))
        .expect(403);
    },
  );

  it('keeps full working metadata for the owner and resolves slugs within that owner', async () => {
    const owned = await request(app.getHttpServer())
      .get(`/cruxes/${privateId}`)
      .set('Authorization', token(alice))
      .expect(200);
    expect(owned.body.meta.systemPrompt).toBe('private prompt');
    for (const [author, id] of [
      [alice, privateId],
      [bob, bobId],
    ]) {
      const response = await request(app.getHttpServer())
        .get('/cruxes/same-slug')
        .set('Authorization', token(author))
        .expect(200);
      expect(response.body.id).toBe(id);
    }
  });

  it('refuses private public URLs and author-mismatched UUIDs', async () => {
    await request(app.getHttpServer())
      .get('/authors/alice/cruxes/same-slug')
      .expect(404);
    await request(app.getHttpServer())
      .get(`/authors/bob/cruxes/${publicId}/artifacts`)
      .expect(404);
  });

  it('serves public and unlisted pages with only public metadata', async () => {
    for (const slug of ['published', 'unlisted']) {
      const response = await request(app.getHttpServer())
        .get(`/authors/alice/cruxes/${slug}`)
        .expect(200);
      expect(response.body.meta).toEqual({ summary: 'Shared summary' });
    }
  });

  it('never embeds a private or foreign root and filters a public root', async () => {
    for (const root of [privateId, bobId, publicId]) {
      await db.query()('authors').where('id', alice).update({ root_id: root });
      const response = await request(app.getHttpServer())
        .get('/authors/alice?embed=root')
        .expect(200);
      if (root === publicId)
        expect(response.body.root.meta).toEqual({ summary: 'Shared summary' });
      else expect(response.body.root).toBeUndefined();
    }
  });

  it('refuses assigning another author’s root', async () => {
    await request(app.getHttpServer())
      .patch(`/authors/${alice}`)
      .set('Authorization', token(alice))
      .send({ rootId: bobId })
      .expect(403);
    expect(
      (await db.query()('authors').where('id', alice).first()).root_id,
    ).not.toBe(bobId);
  });

  it('lists only public Cruxes and links in the public graph', async () => {
    const response = await request(app.getHttpServer())
      .get('/authors/alice/graph')
      .expect(200);
    expect(response.body.nodes.map((node: { id: string }) => node.id)).toEqual([
      publicId,
    ]);
    expect(response.body.links).toEqual([]);
  });

  it('protects standalone Dimensions and refuses links into another account', async () => {
    await request(app.getHttpServer())
      .get('/dimensions/private-link')
      .set('Authorization', token(bob))
      .expect(403);
    await request(app.getHttpServer())
      .get('/dimensions/private-link')
      .set('Authorization', token(alice))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/cruxes/${publicId}/dimensions`)
      .set('Authorization', token(alice))
      .send({ type: 'graft', targetId: bobId })
      .expect(403);
    await db.query()('dimensions').insert({
      id: 'foreign-link',
      source_id: publicId,
      target_id: bobId,
      author_id: alice,
      type: 'graft',
    });
    const response = await request(app.getHttpServer())
      .get(`/cruxes/${publicId}/dimensions`)
      .set('Authorization', token(alice))
      .expect(200);
    expect(response.body.map((row: { id: string }) => row.id).sort()).toEqual([
      'private-link',
      'unlisted-link',
    ]);
  });

  it.each([
    'id',
    'authorId',
    'resourceId',
    'resourceType',
    'homeId',
    'size',
    'mimeType',
    'encoding',
  ])(
    'refuses artifact mass assignment of %s without changing the stored row',
    async (field) => {
      const before = await db
        .query()('artifacts')
        .where('id', 'alice-file')
        .first();
      await request(app.getHttpServer())
        .put('/artifacts/alice-file')
        .set('Authorization', token(alice))
        .send({ [field]: field === 'size' ? 1 : bobId })
        .expect(400);
      expect(
        await db.query()('artifacts').where('id', 'alice-file').first(),
      ).toEqual(before);
    },
  );

  it('allows owned artifact metadata edits and refuses another author', async () => {
    await request(app.getHttpServer())
      .put('/artifacts/alice-file')
      .set('Authorization', token(bob))
      .send({ filename: 'stolen.txt' })
      .expect(403);
    const response = await request(app.getHttpServer())
      .put('/artifacts/alice-file')
      .set('Authorization', token(alice))
      .send({ filename: 'renamed.txt', meta: { caption: 'My work' } })
      .expect(200);
    expect(response.body).toMatchObject({
      filename: 'renamed.txt',
      resourceId: privateId,
      authorId: alice,
      size: 12,
    });
  });

  it.each(['email', 'website', 'avatarUrl'])(
    'rejects unsupported author field %s at validation',
    async (field) => {
      await request(app.getHttpServer())
        .patch(`/authors/${alice}`)
        .set('Authorization', token(alice))
        .send({ [field]: 'https://example.com' })
        .expect(400);
    },
  );

  it('refuses AI access to another account before opening a model stream', async () => {
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set('Authorization', token(bob))
      .set('x-anthropic-key', 'never-use-this-key')
      .send({
        cruxId: privateId,
        messages: [{ role: 'user', content: 'read files' }],
      })
      .expect(403);
  });
});
