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
  alice = id(2),
  bob = id(3),
  aliceAccount = id(4),
  bobAccount = id(5);
const aliceCrux = id(6),
  secondCrux = id(7),
  bobCrux = id(8),
  alicePath = id(9),
  bobPath = id(10),
  aliceMarker = id(11),
  bobMarker = id(12);
const createBody = { slug: 'new-path', title: 'New path', kind: 'wander' };

describe('Path ownership and marker transactions on PostgreSQL', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let db: DbService;
  const env = { ...process.env };
  const token = (account = aliceAccount) =>
    `Bearer ${jwt.sign({ id: account, role: 'author' }, process.env.JWT_SECRET)}`;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'path-test-signing-key';
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
  }, 90_000);
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await fixture?.close();
      process.env = env;
    }
  });
  beforeEach(async () => {
    // This DbService exists only inside the container created by postgresFixture.
    await db.query().raw('TRUNCATE homes CASCADE');
    await db.query()('homes').insert({
      id: home,
      name: 'Test host',
      primary: true,
      type: 'personal',
      kind: 'garden',
    });
    await db
      .query()('accounts')
      .insert([
        {
          id: aliceAccount,
          email: 'alice@example.test',
          role: 'author',
          home_id: home,
        },
        {
          id: bobAccount,
          email: 'bob@example.test',
          role: 'author',
          home_id: home,
        },
      ]);
    await db
      .query()('authors')
      .insert([
        {
          id: alice,
          account_id: aliceAccount,
          username: 'alice',
          display_name: 'Alice',
          home_id: home,
        },
        {
          id: bob,
          account_id: bobAccount,
          username: 'bob',
          display_name: 'Bob',
          home_id: home,
        },
      ]);
    await db
      .query()('cruxes')
      .insert(
        [aliceCrux, secondCrux, bobCrux].map((crux, i) => ({
          id: crux,
          slug: `crux-${i}`,
          title: `Crux ${i}`,
          data: '',
          type: 'living',
          kind: 'page',
          status: 'active',
          visibility: 'private',
          author_id: crux === bobCrux ? bob : alice,
          home_id: home,
        })),
      );
    await db
      .query()('paths')
      .insert([
        {
          id: alicePath,
          slug: 'alice-path',
          title: 'Alice path',
          type: 'living',
          kind: 'wander',
          author_id: alice,
          home_id: home,
        },
        {
          id: bobPath,
          slug: 'bob-path',
          title: 'Bob private path',
          type: 'living',
          kind: 'wander',
          author_id: bob,
          home_id: home,
        },
      ]);
    await db
      .query()('markers')
      .insert([
        {
          id: aliceMarker,
          path_id: alicePath,
          crux_id: aliceCrux,
          order: 0,
          note: 'Keep this note',
          author_id: alice,
        },
        {
          id: bobMarker,
          path_id: bobPath,
          crux_id: bobCrux,
          order: 0,
          note: 'Bob private note',
          author_id: bob,
        },
      ]);
    await db
      .query()('paths')
      .where('id', alicePath)
      .update({ entry: aliceMarker });
    await db.query()('paths').where('id', bobPath).update({ entry: bobMarker });
    await db
      .query()('tags')
      .insert({
        id: id(13),
        resource_type: 'path',
        resource_id: alicePath,
        label: 'private',
        author_id: alice,
        home_id: home,
      });
  });
  afterEach(async () => {
    await db
      .query()
      .raw(
        'DROP TRIGGER IF EXISTS fail_marker_write ON markers; DROP FUNCTION IF EXISTS fail_marker_write(); DROP TRIGGER IF EXISTS fail_path_write ON paths; DROP FUNCTION IF EXISTS fail_path_write()',
      );
  });

  it('lists only the signed-in author’s Paths', async () => {
    const response = await request(app.getHttpServer())
      .get('/paths')
      .set('Authorization', token())
      .expect(200);
    expect(response.body.map((path: { id: string }) => path.id)).toEqual([
      alicePath,
    ]);
  });

  it('resolves slugs within the author and refuses another author’s ID', async () => {
    await request(app.getHttpServer())
      .get('/paths/alice-path')
      .set('Authorization', token())
      .expect(200);
    await request(app.getHttpServer())
      .get('/paths/bob-path')
      .set('Authorization', token())
      .expect(404);
    await request(app.getHttpServer())
      .get(`/paths/${bobPath}`)
      .set('Authorization', token())
      .expect(403);
    await request(app.getHttpServer())
      .get('/paths/bob-path')
      .set('Authorization', token(bobAccount))
      .expect(200);
  });

  it.each(['markers', 'tags'])(
    'keeps %s reads owner-only',
    async (resource) => {
      await request(app.getHttpServer())
        .get(`/paths/${bobPath}/${resource}`)
        .set('Authorization', token())
        .expect(403);
      const own = await request(app.getHttpServer())
        .get(`/paths/${alicePath}/${resource}`)
        .set('Authorization', token())
        .expect(200);
      expect(own.body).toHaveLength(1);
    },
  );

  it.each(['patch', 'delete'] as const)(
    'refuses another author’s %s without mutating the Path',
    async (method) => {
      await request(app.getHttpServer())
        [method](`/paths/${bobPath}`)
        .set('Authorization', token())
        .send(method === 'patch' ? { title: 'Taken' } : {})
        .expect(403);
      expect(
        await db.query()('paths').where('id', bobPath).first(),
      ).toMatchObject({ title: 'Bob private path', deleted: null });
    },
  );

  it.each(['markers', 'tags'])(
    'refuses another author’s %s replacement',
    async (resource) => {
      await request(app.getHttpServer())
        .put(`/paths/${bobPath}/${resource}`)
        .set('Authorization', token())
        .send(resource === 'markers' ? { markers: [] } : { labels: [] })
        .expect(403);
    },
  );

  it.each([
    '/paths',
    `/paths/${alicePath}`,
    `/paths/${alicePath}/markers`,
    `/paths/${alicePath}/tags`,
  ])('requires authentication for %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
  });

  it('creates an empty owned Path, edits it, then soft-deletes it', async () => {
    const created = await request(app.getHttpServer())
      .post('/paths')
      .set('Authorization', token())
      .send(createBody)
      .expect(201);
    expect(created.body).toMatchObject({
      authorId: alice,
      homeId: home,
      entry: null,
    });
    expect(created.body.id).toMatch(/^[\da-f-]{36}$/);
    await request(app.getHttpServer())
      .patch(`/paths/${created.body.id}`)
      .set('Authorization', token())
      .send({ title: 'Revised' })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/paths/${created.body.id}`)
      .set('Authorization', token())
      .expect(204);
    await request(app.getHttpServer())
      .get(`/paths/${created.body.id}`)
      .set('Authorization', token())
      .expect(404);
    const stored = await db
      .query()('paths')
      .where('id', created.body.id)
      .first();
    expect(stored.title).toBe('Revised');
    expect(stored.deleted).not.toBeNull();
  });

  it.each(['id', 'authorId', 'homeId', 'accountId', 'entry'])(
    'rejects caller-supplied %s on creation',
    async (field) => {
      await request(app.getHttpServer())
        .post('/paths')
        .set('Authorization', token())
        .send({ ...createBody, [field]: bobMarker })
        .expect(400);
    },
  );

  it('only accepts a live entry marker belonging to this Path', async () => {
    await request(app.getHttpServer())
      .patch(`/paths/${alicePath}`)
      .set('Authorization', token())
      .send({ entry: bobMarker })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/paths/${alicePath}`)
      .set('Authorization', token())
      .send({ entry: aliceMarker })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/paths/${alicePath}`)
      .set('Authorization', token())
      .send({ entry: null })
      .expect(200);
  });

  it('replaces markers repeatedly under the real uniqueness constraint and retains a valid entry', async () => {
    const first = await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({
        markers: [
          { cruxId: aliceCrux, order: 0, note: 'Updated' },
          { cruxId: secondCrux, order: 1 },
        ],
      })
      .expect(200);
    expect(
      first.body.map((marker: { cruxId: string }) => marker.cruxId),
    ).toEqual([aliceCrux, secondCrux]);
    const reordered = await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({
        markers: [
          { cruxId: secondCrux, order: 0 },
          { cruxId: aliceCrux, order: 1 },
        ],
      })
      .expect(200);
    const entry = await db
      .query()('paths')
      .where('id', alicePath)
      .first('entry');
    expect(
      reordered.body.find((marker: { id: string }) => marker.id === entry.entry)
        .cruxId,
    ).toBe(aliceCrux);
    await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({ markers: [] })
      .expect(200);
    expect(
      (await db.query()('paths').where('id', alicePath).first()).entry,
    ).toBeNull();
    expect(
      await db
        .query()('markers')
        .where('path_id', alicePath)
        .whereNull('deleted'),
    ).toHaveLength(0);
    expect(
      await db.query()('markers').where('path_id', alicePath),
    ).toHaveLength(5);
    await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({ markers: [{ cruxId: aliceCrux, order: 0 }] })
      .expect(200);
  });

  it.each([bobCrux, id(999)])(
    'validates every replacement target before changing existing markers (%s)',
    async (crux) => {
      await request(app.getHttpServer())
        .put(`/paths/${alicePath}/markers`)
        .set('Authorization', token())
        .send({
          markers: [
            { cruxId: secondCrux, order: 0 },
            { cruxId: crux, order: 1 },
          ],
        })
        .expect(crux === bobCrux ? 403 : 404);
      const markers = await db
        .query()('markers')
        .where('path_id', alicePath)
        .whereNull('deleted');
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        id: aliceMarker,
        note: 'Keep this note',
      });
    },
  );

  it('rejects duplicate positions before writing', async () => {
    await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({
        markers: [
          { cruxId: secondCrux, order: 0 },
          { cruxId: aliceCrux, order: 0 },
        ],
      })
      .expect(400);
    expect(
      (await db.query()('markers').where('id', aliceMarker).first()).note,
    ).toBe('Keep this note');
  });

  it('rolls back marker and entry changes when a later write fails', async () => {
    await db
      .query()
      .raw(
        `CREATE FUNCTION fail_marker_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.note = 'fail-test' THEN RAISE EXCEPTION 'fixture refuses later marker'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_marker_write BEFORE INSERT OR UPDATE ON markers FOR EACH ROW EXECUTE FUNCTION fail_marker_write()`,
      );
    await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({
        markers: [
          { cruxId: secondCrux, order: 0, note: 'Would change' },
          { cruxId: aliceCrux, order: 1, note: 'fail-test' },
        ],
      })
      .expect(500);
    expect(
      await db.query()('markers').where('path_id', alicePath),
    ).toHaveLength(1);
    expect(
      await db.query()('markers').where('id', aliceMarker).first(),
    ).toMatchObject({
      note: 'Keep this note',
      deleted: null,
      crux_id: aliceCrux,
    });
    expect(
      (await db.query()('paths').where('id', alicePath).first()).entry,
    ).toBe(aliceMarker);
  });

  it('rejects missing author, invalid authentication and malformed creation', async () => {
    await request(app.getHttpServer())
      .post('/paths')
      .set('Authorization', token(id(999)))
      .send(createBody)
      .expect(404);
    await request(app.getHttpServer())
      .post('/paths')
      .set('Authorization', 'Bearer invalid')
      .send(createBody)
      .expect(401);
    await request(app.getHttpServer())
      .post('/paths')
      .set('Authorization', token())
      .send({ title: 'Missing required fields' })
      .expect(400);
  });

  it.each(['post', 'patch', 'delete'] as const)(
    'reports a failed %s write without changing stored Paths',
    async (method) => {
      await db
        .query()
        .raw(
          `CREATE FUNCTION fail_path_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture refuses Path write'; END $$; CREATE TRIGGER fail_path_write BEFORE INSERT OR UPDATE ON paths FOR EACH ROW EXECUTE FUNCTION fail_path_write()`,
        );
      await request(app.getHttpServer())
        [method](method === 'post' ? '/paths' : `/paths/${alicePath}`)
        .set('Authorization', token())
        .send(method === 'post' ? createBody : { title: 'Should not persist' })
        .expect(500);
      expect(await db.query()('paths')).toHaveLength(2);
      expect(
        await db.query()('paths').where('id', alicePath).first(),
      ).toMatchObject({ title: 'Alice path', deleted: null });
    },
  );

  it.each(['paths', 'markers'])(
    'does not turn a failed %s query into a 404',
    async (table) => {
      await db.query().schema.renameTable(table, `unavailable_${table}`);
      try {
        await request(app.getHttpServer())
          .get(`/paths/${alicePath}${table === 'markers' ? '/markers' : ''}`)
          .set('Authorization', token())
          .expect(500);
      } finally {
        await db.query().schema.renameTable(`unavailable_${table}`, table);
      }
    },
  );

  it('validates marker bounds and forbids supplied ownership', async () => {
    for (const marker of [
      { cruxId: 'not-a-uuid', order: 0 },
      { cruxId: aliceCrux, order: -1 },
      { cruxId: aliceCrux, order: 2147483648 },
      { cruxId: aliceCrux, order: 0, authorId: bob },
    ]) {
      await request(app.getHttpServer())
        .put(`/paths/${alicePath}/markers`)
        .set('Authorization', token())
        .send({ markers: [marker] })
        .expect(400);
    }
    await request(app.getHttpServer())
      .put(`/paths/${alicePath}/markers`)
      .set('Authorization', token())
      .send({
        markers: Array.from({ length: 1001 }, (_, order) => ({
          cruxId: aliceCrux,
          order,
        })),
      })
      .expect(400);
  });

  it('syncs tags through the owner-scoped Path', async () => {
    const result = await request(app.getHttpServer())
      .put(`/paths/${alicePath}/tags`)
      .set('Authorization', token())
      .send({ labels: ['blue', 'green'] })
      .expect(200);
    expect(
      result.body.map((tag: { label: string }) => tag.label).sort(),
    ).toEqual(['blue', 'green']);
    expect(
      await db
        .query()('tags')
        .where('resource_id', alicePath)
        .whereNull('deleted')
        .whereNot('author_id', alice),
    ).toHaveLength(0);
  });
});
