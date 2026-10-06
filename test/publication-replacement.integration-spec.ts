import { FunctionsService } from '../src/functions/functions.service';
import { DomainsRepository } from '../src/domains/domains.repository';
import { LoggerService } from '../src/common/services/logger.service';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { CruxService } from '../src/crux/crux.service';
import { CruxRepository } from '../src/crux/crux.repository';
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
describe('Publication replacement and retry', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  const home = randomUUID(),
    account = randomUUID(),
    author = randomUUID();
  const objects = new Map<string, Buffer>();
  let refuseCss = false;
  let beforeUpload: ((data: Buffer) => Promise<void>) | undefined;
  const files = {
    invalidateCache: jest.fn().mockResolvedValue(undefined),
    deleteByPrefix: jest.fn(async ({ prefix }) => {
      for (const key of objects.keys())
        if (key.startsWith(prefix)) objects.delete(key);
    }),
    upload: jest.fn(async ({ path, data }) => {
      await beforeUpload?.(data);
      if (refuseCss && path.endsWith('style.css'))
        throw new Error('Upload refused');
      objects.set(path, data);
    }),
    download: jest.fn(async ({ path }) => {
      if (!objects.has(path)) throw new Error('Not found');
      return { data: objects.get(path) };
    }),
  };
  // Use the actual bounded uploader and SDK command construction. Only S3 is fake.
  const send = jest.fn(async (command) => {
    const { Bucket, Key, Body, Delete } = command.input;
    const key = `${Bucket}/${Key}`;
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        await beforeUpload?.(Body);
        if (refuseCss && Key === 'style.css') throw new Error('Upload refused');
        objects.set(key, Body);
        return {};
      case 'GetObjectCommand':
        if (!objects.has(key)) throw new Error('Not found');
        return { Body: { transformToByteArray: async () => objects.get(key) } };
      case 'ListObjectsV2Command':
        return {
          Contents: [...objects.keys()]
            .filter((k) => k.startsWith(`${Bucket}/`))
            .map((k) => ({ Key: k.slice(Bucket.length + 1) })),
        };
      case 'DeleteObjectsCommand':
        for (const o of Delete.Objects) objects.delete(`${Bucket}/${o.Key}`);
        return {};
      default:
        return {};
    }
  });
  const buckets = new PublishStorageService(
    {
      createChildLogger: () => ({ info() {}, warn() {}, error() {} }),
    } as never,
    { send } as never,
  );
  const edge = new MockEdgeProvider();
  const token = () =>
    jwt.sign(
      { id: account, email: 'owner@example.com', role: 'author' },
      process.env.JWT_SECRET,
    );
  const previousSecret = process.env.JWT_SECRET;
  const previousLayout = process.env.PUBLISH_LAYOUT;
  const previousRouting = process.env.PUBLISH_REVISION_ROUTING;
  beforeAll(async () => {
    process.env.JWT_SECRET = 'publication-teardown-fixture-secret';
    process.env.PUBLISH_REVISION_ROUTING = '1';
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
    if (previousRouting === undefined)
      delete process.env.PUBLISH_REVISION_ROUTING;
    else process.env.PUBLISH_REVISION_ROUTING = previousRouting;
    if (previousLayout === undefined) delete process.env.PUBLISH_LAYOUT;
    else process.env.PUBLISH_LAYOUT = previousLayout;
    await app?.close();
    await fixture?.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  async function seed() {
    const id = randomUUID();
    await fixture.db.query()('cruxes').insert({
      id,
      author_id: author,
      home_id: home,
      slug: id,
      title: 'Published',
      type: 'webapp',
      data: '',
      status: 'living',
      visibility: 'private',
      meta: {},
    });
    return id;
  }
  function publish(id: string, version: string) {
    return request(app.getHttpServer())
      .post(`/cruxes/${id}/publish`)
      .set('Authorization', `Bearer ${token()}`)
      .field(
        'meta',
        JSON.stringify([{ path: 'index.html' }, { path: 'style.css' }]),
      )
      .attach('files', Buffer.from(`<h1>${version}</h1>`), {
        filename: 'index.html',
        contentType: 'text/html',
      })
      .attach('files', Buffer.from(`/* ${version} */`), {
        filename: 'style.css',
        contentType: 'text/css',
      });
  }
  async function state(id: string) {
    const db = fixture.db.query();
    return {
      crux: await db('cruxes').where({ id }).first(),
      artifacts: await db('artifacts')
        .where({ resource_id: id })
        .whereNull('deleted')
        .orderBy('id'),
      usage: await db('usage_storage').where({ crux_id: id }).first(),
    };
  }

  const create = (id: string, slug: string) =>
    request(app.getHttpServer())
      .post('/cruxes')
      .set('Authorization', `Bearer ${token()}`)
      .send({ id, slug, title: 'New creation', type: 'webapp' });
  it('rejects a live slug collision without deleting publication bytes, artifacts, dimensions or cleanup ownership', async () => {
    process.env.PUBLISH_LAYOUT = 'shared';
    const id = await seed(),
      sibling = await seed();
    await publish(id, 'live').expect(200);
    await fixture.db.query()('dimensions').insert({
      id: randomUUID(),
      source_id: id,
      target_id: sibling,
      author_id: author,
      home_id: home,
      type: 'reference',
    });
    const before = await state(id),
      related = await fixture.db.query()('dimensions').where({ source_id: id });
    const bytes = new Map(objects);
    await create(randomUUID(), id).expect(409);
    expect(await state(id)).toEqual(before);
    expect(
      await fixture.db.query()('dimensions').where({ source_id: id }),
    ).toEqual(related);
    expect(objects).toEqual(bytes);
  });
  it('keeps the existing live owner even when a conflicting insertion would be refused', async () => {
    const id = await seed();
    await publish(id, 'preserved').expect(200);
    const nextId = randomUUID(),
      before = await state(id);
    const db = fixture.db.query();
    await db.raw(
      `CREATE FUNCTION refuse_new_crux() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${nextId}'::uuid THEN RAISE EXCEPTION 'fixture insert refusal'; END IF; RETURN NEW; END $$`,
    );
    await db.raw(
      'CREATE TRIGGER refuse_new_crux BEFORE INSERT ON cruxes FOR EACH ROW EXECUTE FUNCTION refuse_new_crux()',
    );
    try {
      // A collision must be rejected before destructive replacement or INSERT.
      await create(nextId, id).expect(409);
      expect(await state(id)).toEqual(before);
    } finally {
      await db.raw('DROP TRIGGER refuse_new_crux ON cruxes');
      await db.raw('DROP FUNCTION refuse_new_crux()');
    }
  });
  it('refuses reusing a soft-deleted identity without erasing retained metadata', async () => {
    const id = await seed();
    await fixture.db
      .query()('cruxes')
      .where({ id })
      .update({ deleted: new Date(), meta: { retained: 'recovery proof' } });
    const before = await fixture.db.query()('cruxes').where({ id }).first();
    await create(id, randomUUID()).expect(409);
    expect(await fixture.db.query()('cruxes').where({ id }).first()).toEqual(
      before,
    );
  });
  it('reports concurrent fresh slug admission as one create and one conflict', async () => {
    const slug = randomUUID();
    const results = await Promise.all([
      create(randomUUID(), slug),
      create(randomUUID(), slug),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(
      await fixture.db.query()('cruxes').where({ author_id: author, slug }),
    ).toHaveLength(1);
  });

  it('refuses failed secret deletion and listing, retains stored state, and succeeds on retry', async () => {
    const id = await seed();
    const authorization = `Bearer ${token()}`;
    await request(app.getHttpServer())
      .put(`/fn/${id}/secrets/API_KEY`)
      .set('Authorization', authorization)
      .send({ value: 'fixture-only-value' })
      .expect(200);
    const before = await fixture.db
      .query()('crux_secrets')
      .where({ crux_id: id });
    const db = fixture.db.query();
    await db.raw(
      `CREATE FUNCTION refuse_secret_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture secret refusal'; END $$`,
    );
    await db.raw(
      'CREATE TRIGGER refuse_secret_delete BEFORE DELETE ON crux_secrets FOR EACH ROW EXECUTE FUNCTION refuse_secret_delete()',
    );
    try {
      await request(app.getHttpServer())
        .delete(`/fn/${id}/secrets/API_KEY`)
        .set('Authorization', authorization)
        .expect(503);
      expect(await db('crux_secrets').where({ crux_id: id })).toEqual(before);
    } finally {
      await db.raw('DROP TRIGGER refuse_secret_delete ON crux_secrets');
      await db.raw('DROP FUNCTION refuse_secret_delete()');
    }
    // A real unavailable relation must not become a successful empty list.
    await db.schema.renameTable('crux_secrets', 'crux_secrets_unavailable');
    try {
      await request(app.getHttpServer())
        .get(`/fn/${id}/secrets`)
        .set('Authorization', authorization)
        .expect(503);
    } finally {
      await db.schema.renameTable('crux_secrets_unavailable', 'crux_secrets');
    }
    const listed = await request(app.getHttpServer())
      .get(`/fn/${id}/secrets`)
      .set('Authorization', authorization)
      .expect(200);
    expect(listed.body.map((entry: { name: string }) => entry.name)).toEqual([
      'API_KEY',
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('fixture-only-value');
    await request(app.getHttpServer())
      .delete(`/fn/${id}/secrets/API_KEY`)
      .set('Authorization', authorization)
      .expect(200, { name: 'API_KEY', set: false });
    expect(await db('crux_secrets').where({ crux_id: id })).toEqual([]);
  });

  it.each(['shared', 'bucket-per-crux'])(
    '%s preserves live bytes, metadata, downloads and usage after upload refusal, then retries',
    async (layout) => {
      process.env.PUBLISH_LAYOUT = layout;
      const id = await seed();
      await publish(id, 'original').expect(200);
      const before = await state(id);
      const oldObjects = new Map(objects);
      refuseCss = true;
      try {
        await publish(id, 'replacement').expect(500);
      } finally {
        refuseCss = false;
      }
      expect(await state(id)).toEqual(before);
      for (const [key, bytes] of oldObjects)
        expect(objects.get(key)).toEqual(bytes);
      const css = before.artifacts.find((a) => a.meta.path === 'style.css');
      await request(app.getHttpServer())
        .get(`/cruxes/${id}/artifacts/${css.id}/download`)
        .set('Authorization', `Bearer ${token()}`)
        .expect(200)
        .expect('/* original */');
      await publish(id, 'replacement').expect(200);
      const after = await state(id);
      expect(after.crux.meta.publishedVersion).toBe(2);
      expect(after.artifacts).toHaveLength(2);
      expect(after.artifacts.map((a) => a.id)).not.toEqual(
        before.artifacts.map((a) => a.id),
      );
    },
  );
  it('Share, Unshare and Share can recreate the intentionally removed hosted copy', async () => {
    process.env.PUBLISH_LAYOUT = 'shared';
    const id = await seed();
    await publish(id, 'first').expect(200);
    const first = await state(id);
    await request(app.getHttpServer())
      .post(`/cruxes/${id}/unpublish`)
      .set('Authorization', `Bearer ${token()}`)
      .expect(200);
    expect((await state(id)).crux).toBeUndefined();
    await request(app.getHttpServer())
      .post('/cruxes')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        id,
        slug: id,
        title: 'Published again',
        type: 'webapp',
        data: '',
      })
      .expect(201);
    await publish(id, 'second').expect(200);
    const second = await state(id);
    expect(second.crux.id).toBe(id);
    expect(second.crux.meta.publishStorageId).not.toBe(
      first.crux.meta.publishStorageId,
    );
    expect(
      objects.get(`${second.crux.meta.publishStorageId}/style.css`)?.toString(),
    ).toBe('/* second */');
  });

  it('captures the publication head and inventory under the activation row lock', async () => {
    process.env.PUBLISH_LAYOUT = 'shared';
    const id = await seed();
    await publish(id, 'old').expect(200);
    const before = await state(id);
    const db = fixture.db.query();
    const transaction = db.transaction.bind(db);
    let entered!: () => void, resume!: () => void, attempting!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const activation = new Promise<void>((resolve) => {
      attempting = resolve;
    });
    // Pause after the actual PostgreSQL FOR SHARE has acquired the row lock.
    const intercept = jest.spyOn(fixture.db, 'query').mockReturnValueOnce({
      transaction: (callback: any) =>
        transaction(async (trx) =>
          callback(
            new Proxy(trx, {
              apply(target, self, args) {
                const query = Reflect.apply(target, self, args);
                if (args[0] === 'cruxes') {
                  const first = query.first.bind(query);
                  jest
                    .spyOn(query, 'first')
                    .mockImplementationOnce(async () => {
                      const row = await first();
                      entered();
                      await paused;
                      return row;
                    });
                }
                return query;
              },
            }),
          ),
        ),
    } as never);
    const onQuery = (query: { sql: string; bindings: unknown[] }) => {
      if (
        query.sql.includes('"cruxes"') &&
        query.sql.includes('for update') &&
        query.bindings.includes(id)
      )
        attempting();
    };
    db.on('query', onQuery);
    const reading = app.get(CruxRepository).publishedRevision(id);
    let replacing: Promise<request.Response> | undefined;
    try {
      await started;
      replacing = publish(id, 'new').then((result) => result);
      await activation;
      resume();
      const captured = await reading;
      expect(captured.error).toBeNull();
      expect(captured.data?.crux.meta.publishStorageId).toBe(
        before.crux.meta.publishStorageId,
      );
      expect(
        captured.data?.artifacts.map((a) => a.meta.publishStorageId),
      ).toEqual([
        before.crux.meta.publishStorageId,
        before.crux.meta.publishStorageId,
      ]);
      expect((await replacing).status).toBe(200);
      expect((await state(id)).crux.meta.publishStorageId).not.toBe(
        before.crux.meta.publishStorageId,
      );
    } finally {
      resume();
      await reading;
      await replacing;
      db.removeListener('query', onQuery);
      intercept.mockRestore();
    }
  });

  it.each(['descriptor', 'egress', 'handler'])(
    'keeps one complete Function revision across a %s read pause',
    async (seam) => {
      process.env.PUBLISH_LAYOUT = 'shared';
      const id = await seed();
      const upload = (version: string) =>
        request(app.getHttpServer())
          .post(`/cruxes/${id}/publish`)
          .set('Authorization', `Bearer ${token()}`)
          .field(
            'meta',
            JSON.stringify([
              { path: 'index.html' },
              { path: 'functions/egress.json' },
              { path: `functions/${version}.js` },
            ]),
          )
          .attach('files', Buffer.from('<h1>Version</h1>'), {
            filename: 'index.html',
          })
          .attach(
            'files',
            Buffer.from(JSON.stringify({ hosts: [`${version}.example.com`] })),
            { filename: 'egress.json' },
          )
          .attach(
            'files',
            Buffer.from(`export default () => ({ version: "${version}" });`),
            { filename: `${version}.js` },
          );
      await upload('old').expect(200);
      const cruxes = app.get(CruxService);
      const read = cruxes.publishedRevision.bind(cruxes);
      const download = files.download.getMockImplementation()!;
      let activated = false;
      const activate = async () => {
        if (activated) return;
        activated = true;
        await upload('new').expect(200);
      };
      const captured = jest
        .spyOn(cruxes, 'publishedRevision')
        .mockImplementationOnce(async (key) => {
          const descriptor = await read(key);
          if (seam === 'descriptor') await activate();
          return descriptor;
        });
      files.download.mockImplementation(async (input) => {
        const bytes = await download(input);
        if (
          (seam === 'egress' && input.path.endsWith('egress.json')) ||
          (seam === 'handler' && input.path.endsWith('old.js'))
        )
          await activate();
        return bytes;
      });
      try {
        const result = await request(app.getHttpServer())
          .post(`/fn/${id}/old`)
          .send({});
        expect(activated).toBe(true);
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ version: 'old' });
        const next = await request(app.getHttpServer())
          .post(`/fn/${id}/new`)
          .send({})
          .expect(200);
        expect(next.body).toEqual({ version: 'new' });
        await request(app.getHttpServer())
          .post(`/fn/${id}/old`)
          .send({})
          .expect(404);
      } finally {
        captured.mockRestore();
        files.download.mockImplementation(download);
      }
    },
  );

  it('publishing alone registers, updates and removes Function schedules', async () => {
    process.env.PUBLISH_LAYOUT = 'shared';
    const id = await seed();
    const upload = (schedule: string) =>
      request(app.getHttpServer())
        .post(`/cruxes/${id}/publish`)
        .set('Authorization', `Bearer ${token()}`)
        .field('meta', JSON.stringify([{ path: 'functions/tick.js' }]))
        .attach(
          'files',
          Buffer.from(
            `export const schedule = '${schedule}'; export default async (req, ctx) => { await ctx.store.set('tick-proof', ctx.event.name); return { ok: true }; }`,
          ),
          {
            filename: 'tick.js',
            contentType: 'text/javascript',
          },
        );
    const rows = () =>
      fixture.db.query()('function_schedules').where({ crux_id: id });
    await upload('every 1m').expect(200);
    expect(await rows()).toEqual([
      expect.objectContaining({ name: 'tick', schedule: '*/1 * * * *' }),
    ]);
    const initial = (await rows())[0];
    await upload('every 1m').expect(200);
    expect((await rows())[0].next_run).toEqual(initial.next_run);
    const functions = app.get(FunctionsService);
    // No list or invoke request bootstraps this: the API clock finds the row.
    await functions.runDue(new Date(initial.next_run));
    expect((await rows())[0].last_status).toBe('200');
    expect(
      await fixture.db
        .query()('store')
        .where({ crux_id: id, key: 'tick-proof' })
        .first(),
    ).toMatchObject({ value: 'schedule' });
    // A schedule write refusal rolls back publication activation too.
    const before = await state(id);
    const beforeClock = await rows();
    const db = fixture.db.query();
    await db.raw(
      `CREATE FUNCTION refuse_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Clock refused'; END $$`,
    );
    await db.raw(
      `CREATE TRIGGER refuse_clock BEFORE INSERT OR UPDATE ON function_schedules FOR EACH ROW EXECUTE FUNCTION refuse_clock()`,
    );
    try {
      await upload('every 2h').expect(500);
    } finally {
      await db.raw('DROP TRIGGER refuse_clock ON function_schedules');
      await db.raw('DROP FUNCTION refuse_clock()');
    }
    expect(await state(id)).toEqual(before);
    expect(await rows()).toEqual(beforeClock);
    await upload('every 2h').expect(200);
    expect(await rows()).toEqual([
      expect.objectContaining({ name: 'tick', schedule: '0 */2 * * *' }),
    ]);
    await publish(id, 'without functions').expect(200);
    expect(await rows()).toEqual([]);
  });
  it('refuses publication before any writes until the router is enabled', async () => {
    const id = await seed();
    const before = await state(id);
    delete process.env.PUBLISH_REVISION_ROUTING;
    try {
      await publish(id, 'blocked').expect(503);
    } finally {
      process.env.PUBLISH_REVISION_ROUTING = '1';
    }
    expect(await state(id)).toEqual(before);
  });
  it.each(
    ['shared', 'bucket-per-crux'].flatMap((layout) =>
      ['artifacts', 'usage_storage', 'cruxes'].map((table) => [layout, table]),
    ),
  )(
    '%s rolls back every publication record on %s refusal',
    async (layout, table) => {
      process.env.PUBLISH_LAYOUT = layout;
      const id = await seed();
      await publish(id, 'original').expect(200);
      const before = await state(id);
      const oldObjects = new Map(objects);
      const db = fixture.db.query();
      await db.raw(
        `CREATE FUNCTION refuse_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Publication admission refused'; END $$`,
      );
      await db.raw(
        `CREATE TRIGGER refuse_publication BEFORE INSERT OR UPDATE ON ?? FOR EACH ROW EXECUTE FUNCTION refuse_publication()`,
        [table],
      );
      try {
        await publish(id, 'refused').expect(500);
      } finally {
        await db.raw('DROP TRIGGER refuse_publication ON ??', [table]);
        await db.raw('DROP FUNCTION refuse_publication()');
      }
      expect(await state(id)).toEqual(before);
      for (const [key, bytes] of oldObjects)
        expect(objects.get(key)).toEqual(bytes);
      await publish(id, 'retry').expect(200);
      expect((await state(id)).crux.meta.publishedVersion).toBe(2);
    },
  );
  it.each(['shared', 'bucket-per-crux'])(
    '%s metadata sync cannot forge storage and Unshare removes recorded versions',
    async (layout) => {
      process.env.PUBLISH_LAYOUT = layout;
      const id = await seed();
      await publish(id, 'original').expect(200);
      const before = await state(id);
      await request(app.getHttpServer())
        .patch(`/cruxes/${id}`)
        .set('Authorization', `Bearer ${token()}`)
        .send({
          meta: {
            publishStorageId: randomUUID(),
            retiredPublications: [
              { storageId: randomUUID(), layout: 'shared' },
            ],
            summary: 'changed',
          },
        })
        .expect(200);
      const synced = await state(id);
      expect(synced.crux.meta.publishStorageId).toBe(
        before.crux.meta.publishStorageId,
      );
      expect(synced.crux.meta.retiredPublications).toEqual([]);
      expect(synced.crux.meta.summary).toBe('changed');
      await publish(id, 'replacement').expect(200);
      const after = await state(id);
      const resolved = await app
        .get(DomainsService)
        .resolveHost(`${id}.publish.crux.garden`);
      expect(resolved).toMatchObject({
        storageId: after.crux.meta.publishStorageId,
        legacy: layout === 'shared',
      });
      await request(app.getHttpServer())
        .post(`/cruxes/${id}/unpublish`)
        .set('Authorization', `Bearer ${token()}`)
        .expect(200);
      for (const storageId of [
        before.crux.meta.publishStorageId,
        after.crux.meta.publishStorageId,
      ])
        expect(
          [...objects.keys()].some((key) =>
            key.startsWith(
              layout === 'shared'
                ? `${storageId}/`
                : `${buckets.bucketName(storageId)}/`,
            ),
          ),
        ).toBe(false);
    },
  );
  it.each(['shared', 'bucket-per-crux'])(
    '%s refuses an older upload that finishes after a newer publication',
    async (layout) => {
      process.env.PUBLISH_LAYOUT = layout;
      const id = await seed();
      await publish(id, 'original').expect(200);
      let resume!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      beforeUpload = async (data) => {
        if (data.toString().includes('slow')) {
          entered();
          await paused;
        }
      };
      const slow = publish(id, 'slow').then((r) => r);
      try {
        await started;
        await publish(id, 'newest').expect(200);
        const committed = await state(id);
        const liveObjects = new Map(objects);
        resume();
        expect((await slow).status).toBe(409);
        expect(await state(id)).toEqual(committed);
        for (const [key, bytes] of liveObjects)
          expect(objects.get(key)).toEqual(bytes);
      } finally {
        resume();
        beforeUpload = undefined;
        await slow;
      }
    },
  );
  it('keeps committed bytes when the database commit acknowledgement is lost', async () => {
    process.env.PUBLISH_LAYOUT = 'shared';
    const id = await seed();
    await publish(id, 'original').expect(200);
    const repo = app.get(CruxRepository);
    const commit = repo.commitPublication.bind(repo);
    const lostReply = jest
      .spyOn(repo, 'commitPublication')
      .mockImplementationOnce(async (...args) => {
        await commit(...args);
        return { data: null, error: new Error('Connection lost after commit') };
      });
    try {
      await publish(id, 'committed').expect(500);
    } finally {
      lostReply.mockRestore();
    }
    const current = await state(id);
    expect(current.crux.meta.publishedVersion).toBe(2);
    expect(
      objects
        .get(`${current.crux.meta.publishStorageId}/style.css`)
        ?.toString(),
    ).toBe('/* committed */');
  });
  it('an upload cannot reactivate a site after Unshare starts and cleanup refuses', async () => {
    process.env.PUBLISH_LAYOUT = 'shared';
    const id = await seed();
    await publish(id, 'original').expect(200);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    beforeUpload = async (data) => {
      if (data.toString().includes('slow')) {
        entered();
        await paused;
      }
    };
    const slow = publish(id, 'slow').then((r) => r);
    try {
      await started;
      files.deleteByPrefix.mockRejectedValueOnce(new Error('Cleanup refused'));
      await request(app.getHttpServer())
        .post(`/cruxes/${id}/unpublish`)
        .set('Authorization', `Bearer ${token()}`)
        .expect(500);
      resume();
      expect((await slow).status).toBe(409);
      expect((await state(id)).crux.meta.publishedVersion).toBe(1);
      await request(app.getHttpServer())
        .post(`/cruxes/${id}/unpublish`)
        .set('Authorization', `Bearer ${token()}`)
        .expect(200);
    } finally {
      resume();
      beforeUpload = undefined;
      await slow;
    }
  });
  it('custom domains keep the old bucket after upload refusal, then durably retry a refused origin update', async () => {
    process.env.PUBLISH_LAYOUT = 'bucket-per-crux';
    const id = await seed();
    await publish(id, 'original').expect(200);
    const original = (await state(id)).crux.meta.publishStorageId;
    const domain = randomUUID();
    const tenant = await edge.createTenant(`${id}.example.com`, id, original);
    await fixture.db
      .query()('custom_domains')
      .insert({
        id: domain,
        crux_id: id,
        author_id: author,
        hostname: `${id}.example.com`,
        status: 'active',
        token: 'fixture',
        tenant_id: tenant.tenantId,
      });
    refuseCss = true;
    try {
      await publish(id, 'refused').expect(500);
    } finally {
      refuseCss = false;
    }
    expect(edge.tenants.get(tenant.tenantId)?.storageId).toBe(original);
    expect(
      (await fixture.db.query()('custom_domains').where({ id: domain }).first())
        .status,
    ).toBe('active');
    const origin = jest
      .spyOn(edge, 'setPublication')
      .mockRejectedValue(new Error('CDN unavailable'));
    try {
      await publish(id, 'committed').expect(200);
      await app.get(DomainsService).activatePublication(id);
      const pending = await fixture.db
        .query()('custom_domains')
        .where({ id: domain })
        .first();
      expect(pending.status).toBe('issuing');
      expect(pending.error).toContain('Publication update pending');
      expect(edge.tenants.get(tenant.tenantId)?.storageId).toBe(original);
      expect(
        objects.get(`${buckets.bucketName(original)}/style.css`)?.toString(),
      ).toBe('/* original */');
    } finally {
      origin.mockRestore();
    }
    // Fresh domain-service instance, same durable database queue: no in-memory job is required.
    const resumed = new DomainsService(
      app.get(DomainsRepository),
      app.get(LoggerService),
    );
    resumed.useProviders(edge, {
      cnameTargets: async () => [],
      txtValues: async () => [],
      addresses: async () => [],
    });
    await resumed.pollIssuing();
    const committed = (await state(id)).crux.meta.publishStorageId;
    expect(edge.tenants.get(tenant.tenantId)?.storageId).toBe(committed);
    expect(
      (await fixture.db.query()('custom_domains').where({ id: domain }).first())
        .status,
    ).toBe('active');
    await app
      .get(DomainsRepository)
      .finishPublicationCheck(domain, id, original, {
        status: 'active',
        error: null,
      });
    expect(
      (await fixture.db.query()('custom_domains').where({ id: domain }).first())
        .status,
    ).toBe('issuing');
    await resumed.pollIssuing();
    expect(
      (await fixture.db.query()('custom_domains').where({ id: domain }).first())
        .status,
    ).toBe('active');
    const before = await state(id);
    process.env.PUBLISH_LAYOUT = 'shared';
    await publish(id, 'incompatible').expect(400);
    expect(await state(id)).toEqual(before);
  });
});
