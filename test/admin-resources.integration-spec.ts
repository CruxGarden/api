import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { DbService } from '../src/common/services/db.service';
import { LoggerService } from '../src/common/services/logger.service';
import { KeyMaster } from '../src/common/services/key.master';
import { sqliteGraphConfig } from '../src/common/database/sqlite-graph';
import { createRequestValidationPipe } from '../src/common/validation/request-validation';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { HomeController } from '../src/home/home.controller';
import { HomeService } from '../src/home/home.service';
import { HomeRepository } from '../src/home/home.repository';
import { TagController } from '../src/tag/tag.controller';
import { TagService } from '../src/tag/tag.service';
import { TagRepository } from '../src/tag/tag.repository';

/** Real guards, services, repositories and SQL; host-level administration is not Garden ownership. */
describe('Home and Tag administration boundary', () => {
  let app: INestApplication;
  let db: DbService;
  const env = { ...process.env };
  const token = (role: string) =>
    `Bearer ${jwt.sign({ id: 'account', role }, process.env.JWT_SECRET)}`;
  const home = {
    name: 'Another host',
    type: 'personal',
    kind: 'garden',
    meta: { privateConfig: 'host-only' },
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'admin-resources-test-key';
    process.env.BASE_URL = 'https://api.example.test';
    process.env.NURSERY_MODE = 'false';
    db = new DbService(new LoggerService(), sqliteGraphConfig(':memory:'));
    await db.query().schema.createTable('homes', (t) => {
      t.string('id').primary();
      t.string('name');
      t.string('description');
      t.boolean('primary').defaultTo(false);
      t.string('type');
      t.string('kind');
      t.json('meta');
      t.timestamp('created');
      t.timestamp('updated');
      t.timestamp('deleted');
    });
    await db
      .query()
      .raw(
        'CREATE UNIQUE INDEX primary_home ON homes ("primary") WHERE "primary" = 1 AND deleted IS NULL',
      );
    await db.query().schema.createTable('tags', (t) => {
      t.string('id').primary();
      t.string('label');
      t.string('resource_type');
      t.string('resource_id');
      t.string('author_id');
      t.string('home_id').references('homes.id');
      t.boolean('system').defaultTo(false);
      t.timestamp('created');
      t.timestamp('updated');
      t.timestamp('deleted');
      t.unique(['resource_type', 'resource_id', 'label']);
    });
    const module = await Test.createTestingModule({
      controllers: [HomeController, TagController],
      providers: [
        HomeService,
        HomeRepository,
        TagService,
        TagRepository,
        KeyMaster,
        LoggerService,
        { provide: DbService, useValue: db },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    app.useGlobalFilters(new HttpExceptionFilter(new LoggerService()));
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    process.env = env;
  });
  beforeEach(async () => {
    await db.query()('tags').delete();
    await db.query()('homes').delete();
    await db
      .query()('homes')
      .insert({ ...home, id: 'home', primary: true });
    await db
      .query()('tags')
      .insert([
        {
          id: 'tag-a',
          label: 'alpha',
          resource_id: 'crux-a',
          resource_type: 'crux',
          home_id: 'home',
        },
        {
          id: 'tag-b',
          label: 'alpha',
          resource_id: 'crux-b',
          resource_type: 'crux',
          home_id: 'home',
        },
        {
          id: 'tag-c',
          label: 'beta',
          resource_id: 'path-c',
          resource_type: 'path',
          home_id: 'home',
        },
        {
          id: 'tag-deleted',
          label: 'alpha',
          resource_id: 'crux-deleted',
          resource_type: 'crux',
          home_id: 'home',
          deleted: new Date(),
        },
      ]);
  });

  it.each([
    ['get', '/homes'],
    ['get', '/homes/home'],
    ['post', '/homes'],
    ['patch', '/homes/home'],
    ['delete', '/homes/home'],
    ['get', '/tags'],
    ['get', '/tags/tag-a'],
    ['patch', '/tags/tag-a'],
    ['delete', '/tags/tag-a'],
  ] as const)(
    'requires administrator privilege for %s %s',
    async (method, path) => {
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', token('author'))
        .send(method === 'post' ? home : {})
        .expect(403);
      expect(await db.query()('homes').whereNull('deleted')).toHaveLength(1);
      expect(await db.query()('tags').whereNull('deleted')).toHaveLength(3);
    },
  );

  it.each(['admin', 'keeper'])(
    'allows %s to inspect host records and every live tag identity with its frequency',
    async (role) => {
      const response = await request(app.getHttpServer())
        .get('/homes/home')
        .set('Authorization', token(role))
        .expect(200);
      expect(response.body.meta).toEqual(home.meta);
      const tags = await request(app.getHttpServer())
        .get('/tags')
        .set('Authorization', token(role))
        .expect(200);
      expect(tags.body.map((tag: { id: string }) => tag.id)).toEqual([
        'tag-a',
        'tag-b',
        'tag-c',
      ]);
      expect(
        tags.body.map((tag: { count: number }) => Number(tag.count)),
      ).toEqual([2, 2, 1]);
    },
  );

  it('filters tags with actual SQL, preserving row identities', async () => {
    const response = await request(app.getHttpServer())
      .get('/tags?search=ALP&resourceType=crux&sort=alpha')
      .set('Authorization', token('admin'))
      .expect(200);
    expect(response.body.map((tag: { id: string }) => tag.id)).toEqual([
      'tag-a',
      'tag-b',
    ]);
  });

  it('creates, edits and soft-deletes a Home without allowing identity reassignment', async () => {
    const create = await request(app.getHttpServer())
      .post('/homes')
      .set('Authorization', token('admin'))
      .send(home)
      .expect(201);
    expect(create.body.id).toMatch(/^[\da-f-]{36}$/);
    await request(app.getHttpServer())
      .patch(`/homes/${create.body.id}`)
      .set('Authorization', token('admin'))
      .send({ name: 'Updated host' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/homes/${create.body.id}`)
      .set('Authorization', token('admin'))
      .send({ id: 'replacement' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/homes')
      .set('Authorization', token('admin'))
      .send({ ...home, id: 'chosen' })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/homes/${create.body.id}`)
      .set('Authorization', token('admin'))
      .expect(204);
    const stored = await db
      .query()('homes')
      .where('id', create.body.id)
      .first();
    expect(stored.deleted).not.toBeNull();
    expect(stored.name).toBe('Updated host');
    await request(app.getHttpServer())
      .get(`/homes/${create.body.id}`)
      .set('Authorization', token('admin'))
      .expect(404);
  });

  it('keeps conflicting Home writes as 409 and rejects non-object metadata', async () => {
    await request(app.getHttpServer())
      .post('/homes')
      .set('Authorization', token('admin'))
      .send({ ...home, primary: true })
      .expect(409);
    await request(app.getHttpServer())
      .post('/homes')
      .set('Authorization', token('admin'))
      .send({ ...home, meta: 'not an object' })
      .expect(400);
  });

  it('limits repository updates even when an internal caller supplies extra fields', async () => {
    await app.get(HomeRepository).update('home', {
      id: 'replacement',
      name: 'Allowed',
      deleted: new Date(),
    } as never);
    expect(await db.query()('homes').where('id', 'home').first()).toMatchObject(
      { name: 'Allowed', deleted: null },
    );
    await app.get(TagRepository).update('tag-a', {
      label: 'allowed',
      resourceId: 'other',
      authorId: 'other',
      deleted: new Date(),
    } as never);
    expect(await db.query()('tags').where('id', 'tag-a').first()).toMatchObject(
      { label: 'allowed', resource_id: 'crux-a', deleted: null },
    );
  });

  it('edits and soft-deletes tags without moving them to another resource', async () => {
    await request(app.getHttpServer())
      .patch('/tags/tag-a')
      .set('Authorization', token('admin'))
      .send({ label: 'changed', system: true })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/tags/tag-a')
      .set('Authorization', token('admin'))
      .send({ label: 'changed', resourceId: 'someone-else' })
      .expect(400);
    await request(app.getHttpServer())
      .delete('/tags/tag-a')
      .set('Authorization', token('admin'))
      .expect(204);
    const stored = await db.query()('tags').where('id', 'tag-a').first();
    expect(stored).toMatchObject({
      label: 'changed',
      resource_id: 'crux-a',
      system: 1,
    });
    expect(stored.deleted).not.toBeNull();
  });
});
