import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import knex from 'knex';
import * as request from 'supertest';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { ExploreController } from './explore.controller';
import { ExploreCruxRow, ExploreRepository } from './explore.repository';
import { ExploreService } from './explore.service';

/**
 * ADR 0085 install links: `GET /explore/cruxes/:id` resolves a published Tool
 * or Mood by id — link-only ones included — in the shape of one Explore result.
 */

const TOOL_ID = '11111111-1111-4111-8111-111111111111';
const MOOD_ID = '22222222-2222-4222-8222-222222222222';

/** Working state a crux keeps in meta that the public must never see. */
const PRIVATE_META = {
  systemPrompt: 'private prompt',
  model: 'claude-private',
  projectPath: '/Users/alice/Garden/secret',
  backgroundQueue: [{ task: 'private task' }],
  toolManifest: { context: 'private context', greeting: 'private greeting' },
};
const PRIVATE_KEYS = Object.keys(PRIVATE_META);

function toolRow(): ExploreCruxRow {
  return {
    id: TOOL_ID,
    slug: 'sketch',
    title: 'Sketch',
    description: 'A p5 sketchbook',
    kind: 'tool',
    meta: {
      ...PRIVATE_META,
      summary: { purpose: 'Draw with code' },
      toolPackage: {
        version: '1.2.0',
        artifactId: 'art-1',
        fingerprint: 'abc',
        size: 2048,
        summary: {
          name: 'Sketch',
          version: '1.2.0',
          license: 'LGPL-2.1',
          permissions: ['document'],
          greeting: 'private greeting',
        },
      },
    },
    created: '2026-10-01T00:00:00.000Z',
    updated: '2026-10-02T00:00:00.000Z',
    author_username: 'ada',
    author_display_name: 'Ada',
    author_meta: { avatarUrl: '/authors/a1/avatar' },
    tags: ['art', 'code'],
  };
}

function moodRow(): ExploreCruxRow {
  return {
    id: MOOD_ID,
    slug: 'night-rain',
    title: 'Night Rain',
    description: null,
    kind: 'mood',
    meta: { ...PRIVATE_META, mood: { accent: '#5fd2a5' } },
    created: '2026-10-01T00:00:00.000Z',
    updated: '2026-10-01T00:00:00.000Z',
    author_username: 'ada',
    author_display_name: null,
    author_meta: null,
    tags: [],
  };
}

function serviceWith(
  row: ExploreCruxRow | null,
  takedown = false,
): { service: ExploreService; repo: Record<string, jest.Mock> } {
  const repo = {
    findPublishedPackage: jest.fn(async () => row),
    hasActiveTakedown: jest.fn(async () => takedown),
  };
  const service = new ExploreService(
    repo as never,
    { createChildLogger: () => ({}) } as never,
  );
  return { service, repo };
}

function expectNoPrivateMeta(result: { meta?: unknown }) {
  const meta = result.meta as Record<string, unknown>;
  for (const key of PRIVATE_KEYS) expect(meta).not.toHaveProperty(key);
  const json = JSON.stringify(result);
  for (const leak of [
    'private prompt',
    'claude-private',
    '/Users/alice',
    'private task',
    'private context',
    'private greeting',
  ])
    expect(json).not.toContain(leak);
}

describe('ExploreRepository.publishedPackageQuery', () => {
  function repo() {
    const k = knex({ client: 'pg' });
    return new ExploreRepository(
      { query: () => k } as never,
      { createChildLogger: () => ({}) } as never,
    );
  }

  it('selects the Explore card for a public, live Tool or Mood of a live author, Discoverable or not', () => {
    const { sql, bindings } = repo()
      .publishedPackageQuery(TOOL_ID)
      .toSQL()
      .toNative();
    const listing = repo().findCruxesQuery({}).toSQL().toNative().sql;
    // Same columns as one GET /explore result
    expect(sql.slice(0, sql.indexOf(' where '))).toBe(
      listing.slice(0, listing.indexOf(' where ')),
    );
    expect(sql).toContain('"c"."visibility" = $1');
    expect(sql).toContain('"c"."deleted" is null');
    expect(sql).toContain('"a"."deleted" is null');
    expect(sql).toContain('"c"."id" = $2');
    expect(sql).toContain('"c"."kind" in ($3, $4)');
    expect(sql).not.toContain('discoverable');
    expect(bindings).toEqual(['public', TOOL_ID, 'tool', 'mood']);
  });
});

describe('ExploreService.getPublishedPackage', () => {
  it('returns a published Tool in the Explore result shape with its public meta and trust summary', async () => {
    const { service, repo } = serviceWith(toolRow());
    const result = await service.getPublishedPackage(TOOL_ID);
    expect(repo.findPublishedPackage).toHaveBeenCalledWith(TOOL_ID);
    expect(repo.hasActiveTakedown).toHaveBeenCalledWith(TOOL_ID);
    expect(result).toMatchObject({
      id: TOOL_ID,
      slug: 'sketch',
      title: 'Sketch',
      kind: 'tool',
      author_username: 'ada',
      author_display_name: 'Ada',
      author_meta: { avatarUrl: '/authors/a1/avatar' },
      tags: ['art', 'code'],
    });
    expect(result.meta).toMatchObject({
      summary: { purpose: 'Draw with code' },
      toolPackage: {
        version: '1.2.0',
        artifactId: 'art-1',
        fingerprint: 'abc',
        size: 2048,
      },
      toolSummary: {
        name: 'Sketch',
        version: '1.2.0',
        publisher: 'ada',
        license: 'LGPL-2.1',
        sizeBytes: 2048,
        permissions: ['document'],
        sandboxed: true,
      },
    });
    expectNoPrivateMeta(result);
  });

  it('resolves a link-only (non-Discoverable) Mood', async () => {
    const { service } = serviceWith(moodRow());
    const result = await service.getPublishedPackage(MOOD_ID);
    expect(result).toMatchObject({ id: MOOD_ID, kind: 'mood' });
    expect(result.meta).toMatchObject({ mood: { accent: '#5fd2a5' } });
    expect(result.meta).not.toHaveProperty('toolSummary');
    expectNoPrivateMeta(result);
  });

  it('404s a creation even if a row comes back, so creations cannot be enumerated by id', async () => {
    for (const kind of ['page', 'webapp', 'document', null]) {
      const { service } = serviceWith({ ...toolRow(), kind });
      await expect(service.getPublishedPackage(TOOL_ID)).rejects.toThrow(
        NotFoundException,
      );
    }
  });

  it('404s an unpublished, private or deleted crux (no public, live row)', async () => {
    const { service, repo } = serviceWith(null);
    await expect(service.getPublishedPackage(TOOL_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.hasActiveTakedown).not.toHaveBeenCalled();
  });

  it('404s a Tool or Mood under an active takedown', async () => {
    const { service } = serviceWith(moodRow(), true);
    await expect(service.getPublishedPackage(MOOD_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('GET /explore/cruxes/:id', () => {
  let app: INestApplication;
  const repo = {
    findPublishedPackage: jest.fn(),
    hasActiveTakedown: jest.fn(async () => false),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExploreController],
      providers: [
        ExploreService,
        { provide: ExploreRepository, useValue: repo },
        { provide: DbService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { createChildLogger: () => ({}) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    repo.findPublishedPackage.mockReset();
    repo.hasActiveTakedown.mockReset().mockResolvedValue(false);
  });

  it('answers a link-only Mood without auth, with public meta only', async () => {
    repo.findPublishedPackage.mockResolvedValue(moodRow());
    const res = await request(app.getHttpServer())
      .get(`/explore/cruxes/${MOOD_ID}`)
      .expect(200);
    expect(res.body).toMatchObject({
      id: MOOD_ID,
      kind: 'mood',
      author_username: 'ada',
    });
    expectNoPrivateMeta(res.body);
  });

  it('answers 404 for anything that is not a published, live Tool or Mood', async () => {
    repo.findPublishedPackage.mockResolvedValue({ ...toolRow(), kind: 'page' });
    await request(app.getHttpServer())
      .get(`/explore/cruxes/${TOOL_ID}`)
      .expect(404);
    repo.findPublishedPackage.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/explore/cruxes/${TOOL_ID}`)
      .expect(404);
    repo.findPublishedPackage.mockResolvedValue(toolRow());
    repo.hasActiveTakedown.mockResolvedValue(true);
    await request(app.getHttpServer())
      .get(`/explore/cruxes/${TOOL_ID}`)
      .expect(404);
  });

  it('answers 400 for an id that is not a UUID, without touching the database', async () => {
    for (const bad of ['not-a-uuid', '123', `${TOOL_ID}x`, 'sketch'])
      await request(app.getHttpServer())
        .get(`/explore/cruxes/${bad}`)
        .expect(400);
    expect(repo.findPublishedPackage).not.toHaveBeenCalled();
  });
});
