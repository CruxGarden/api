import { Controller, Get, INestApplication, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import * as request from 'supertest';
import { DbService } from '../src/common/services/db.service';
import { LoggerService } from '../src/common/services/logger.service';
import { sqliteGraphConfig } from '../src/common/database/sqlite-graph';
import { ExploreController } from '../src/explore/explore.controller';
import { ExploreService } from '../src/explore/explore.service';

class ItemModel {
  id: number;
  constructor(row: Record<string, unknown>) {
    this.id = Number(row.itemId);
  }
}

@Controller('items')
class ItemsFixture {
  constructor(private readonly db: DbService) {}

  @Get('modeled')
  modeled(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.db.paginate({
      model: ItemModel,
      query: this.db
        .query()
        .from('items')
        .select('id as item_id')
        .orderBy('id'),
      request: req,
      response: res,
    });
  }

  @Get()
  list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.db.paginate({
      query: this.db.query().from('items').orderBy('id'),
      request: req,
      response: res,
    });
  }
}

describe('Bounded HTTP pagination over actual SQL', () => {
  let app: INestApplication;
  let db: DbService;
  const previousBase = process.env.BASE_URL;
  const getPopularTags = jest.fn(async () => []);
  beforeAll(async () => {
    process.env.BASE_URL = 'https://api.example.test';
    db = new DbService(new LoggerService(), sqliteGraphConfig(':memory:'));
    await db.query().schema.createTable('items', (t) => {
      t.integer('id').primary();
    });
    await db
      .query()('items')
      .insert(Array.from({ length: 145 }, (_, i) => ({ id: i + 1 })));
    const module = await Test.createTestingModule({
      controllers: [ItemsFixture, ExploreController],
      providers: [
        { provide: DbService, useValue: db },
        { provide: ExploreService, useValue: { getPopularTags } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    if (previousBase === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBase;
  });

  it('converts SQL column names and constructs the declared API model', async () => {
    const response = await request(app.getHttpServer())
      .get('/items/modeled?perPage=1')
      .expect(200);
    expect(response.body).toEqual([{ id: 1 }]);
  });

  it('defaults to 25 rows and tells clients how many pages exist', async () => {
    const response = await request(app.getHttpServer())
      .get('/items')
      .expect(200);
    expect(response.body).toHaveLength(25);
    expect(JSON.parse(response.headers.pagination)).toEqual({
      currentPage: 1,
      perPage: 25,
      total: 145,
      lastPage: 6,
    });
    expect(response.headers.link).toContain('page=6');
  });

  it.each(['perPage', 'per_page'])(
    'caps %s in SQL and emits followable links using the effective size',
    async (name) => {
      const first = await request(app.getHttpServer())
        .get(`/items?${name}=100000`)
        .expect(200);
      expect(first.body).toHaveLength(100);
      expect(JSON.parse(first.headers.pagination)).toMatchObject({
        perPage: 100,
        lastPage: 2,
      });
      const next = /<([^>]+)>;[^,]*rel="[^"]*\bnext\b[^"]*"/.exec(
        first.headers.link,
      )?.[1];
      expect(next).toBeDefined();
      const nextUrl = new URL(next!);
      expect(nextUrl.searchParams.get(name)).toBe('100');
      const second = await request(app.getHttpServer())
        .get(nextUrl.pathname + nextUrl.search)
        .expect(200);
      expect(second.body).toHaveLength(45);
      expect(second.body[0].id).toBe(101);
      expect(
        new Set(
          [...first.body, ...second.body].map((r: { id: number }) => r.id),
        ).size,
      ).toBe(145);
    },
  );

  it.each([
    'perPage=-1',
    'perPage=0',
    'perPage=1.5',
    'perPage=10x',
    'perPage=Infinity',
    'perPage=1&perPage=2',
    'page=-1',
    'page=0',
    'page=1000001',
    'page=9007199254740992',
  ])('rejects malformed or unbounded pagination (%s)', async (query) => {
    await request(app.getHttpServer()).get(`/items?${query}`).expect(400);
  });

  it('bounds public tag limits and refuses malformed values', async () => {
    await request(app.getHttpServer())
      .get('/explore/tags?limit=9999')
      .expect(200);
    expect(getPopularTags).toHaveBeenLastCalledWith(200, undefined);
    for (const limit of ['-1', '0', '12x', '1.5']) {
      await request(app.getHttpServer())
        .get(`/explore/tags?limit=${limit}`)
        .expect(400);
    }
  });

  it('never generates page zero for empty results', async () => {
    await db.query()('items').delete();
    const response = await request(app.getHttpServer())
      .get('/items')
      .expect(200);
    expect(response.body).toEqual([]);
    expect(JSON.parse(response.headers.pagination)).toMatchObject({
      total: 0,
      lastPage: 1,
    });
    expect(response.headers.link).not.toContain('page=0');
  });
});
