import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { DbService, DATABASE_CONFIG } from '../services/db.service';
import { LoggerService } from '../services/logger.service';
import { KeyMaster } from '../services/key.master';
import { CruxRepository } from '../../crux/crux.repository';
import { CruxGraphService } from '../../crux/crux-graph.service';
import { DimensionRepository } from '../../dimension/dimension.repository';
import { DimensionService } from '../../dimension/dimension.service';
import { CruxKind, CruxVisibility } from '../types/enums';
import { prepareDesktopGraph, sqliteGraphConfig } from './sqlite-graph';

const Database = require('better-sqlite3');
// Snapshot of the real desktop schema at app 084f19f95. This fixture allows
// the API repository's CI to run independently of the app checkout.
const schema = readFileSync(
  resolve(__dirname, '../../../test/fixtures/desktop-schema.sql'),
  'utf8',
);
const sourceSchema = resolve(
  __dirname,
  '../../../../app/src/services/sqlite/schema.sql',
);
const authorId = '82a31c44-1e81-4a4f-aa88-7c3e941c1565';
const homeId = 'ebd5394c-74cd-4a77-a2bb-61f448ba850e';

describe('actual API graph repositories over desktop SQLite', () => {
  let scratch: string;
  let filename: string;
  let module: TestingModule;
  let db: DbService;
  let cruxes: CruxRepository;
  let graph: CruxGraphService;
  let dimensions: DimensionService;

  async function openApi() {
    module = await Test.createTestingModule({
      providers: [
        { provide: DATABASE_CONFIG, useValue: sqliteGraphConfig(filename) },
        DbService,
        LoggerService,
        KeyMaster,
        CruxRepository,
        CruxGraphService,
        DimensionRepository,
        DimensionService,
      ],
    }).compile();
    await module.init();
    db = module.get(DbService);
    cruxes = module.get(CruxRepository);
    graph = module.get(CruxGraphService);
    dimensions = module.get(DimensionService);
  }

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crux-api-sqlite-'));
    filename = join(scratch, 'cruxgarden.db');
    const seed = new Database(filename);
    try {
      seed.exec(schema);
      seed
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('keep-me', 'unchanged');
    } finally {
      seed.close();
    }
    await openApi();
    await prepareDesktopGraph(db.query());
  });

  afterEach(async () => {
    await module?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  async function createCrux(kind = CruxKind.GARDEN) {
    const id = randomUUID();
    const result = await graph.create({
      id,
      slug: id,
      title: 'A Garden',
      data: '{"keepThis":"opaque text"}',
      kind,
      authorId,
      homeId,
      discoverable: false,
      meta: {
        displayName: 'Kitchen',
        nested: { camelCase: true, created: 'not a date' },
      },
    });
    expect(result.visibility).toBe(CruxVisibility.PRIVATE);
    return result;
  }

  it('uses the desktop schema and adds tombstones idempotently without replacing existing data', async () => {
    if (existsSync(sourceSchema))
      expect(schema).toBe(readFileSync(sourceSchema, 'utf8'));
    await prepareDesktopGraph(db.query());
    const columns = await db.query().raw('PRAGMA table_info(dimensions)');
    expect(
      columns.filter((c: { name: string }) => c.name === 'deleted'),
    ).toHaveLength(1);
    expect(
      await db.query()('settings').where({ key: 'keep-me' }).first(),
    ).toMatchObject({ value: 'unchanged' });
    expect(await db.query().raw('PRAGMA database_list')).toEqual([
      expect.objectContaining({ name: 'main', file: realpathSync(filename) }),
    ]);
  });

  it('round-trips recursive Garden relationships, metadata edits and deletion across restart', async () => {
    const root = await createCrux();
    const garden = await createCrux();
    const project = await createCrux(CruxKind.WEBAPP);
    const first = await graph.createDimension(root.id, {
      targetId: garden.id,
      type: 'garden',
      kind: 'membership',
      authorId,
      homeId,
      meta: { displayOrder: 1, origin: { cruxId: garden.id } },
    });
    await dimensions.create({
      sourceId: garden.id,
      targetId: project.id,
      type: 'garden',
      kind: 'membership',
      authorId,
      homeId,
    });
    const children = await graph.getDimensionsQuery(root.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      target_id: garden.id,
      kind: 'membership',
      meta: first.meta,
      target_data: '{"keepThis":"opaque text"}',
    });
    await dimensions.update(first.id, { meta: { displayOrder: 2 } });
    await module.close();
    await openApi();
    expect(await dimensions.findById(first.id)).toMatchObject({
      sourceId: root.id,
      targetId: garden.id,
      kind: 'membership',
      meta: { displayOrder: 2, origin: { cruxId: garden.id } },
    });
    expect(await dimensions.findBySourceIdAndTypeQuery(garden.id)).toHaveLength(
      1,
    );
    await dimensions.delete(first.id);
    await expect(dimensions.findById(first.id)).rejects.toThrow(
      'Dimension not found',
    );
    expect(await dimensions.findBySourceIdAndTypeQuery(root.id)).toEqual([]);
    const tombstone = await db
      .query()('dimensions')
      .where({ id: first.id })
      .first();
    expect(tombstone.deleted).toBeInstanceOf(Date);
    expect((await cruxes.findBy('id', garden.id)).data.id).toBe(garden.id);
    await module.close();
    await openApi();
    expect(await dimensions.findBySourceIdAndTypeQuery(root.id)).toEqual([]);
  });

  it('preserves all four Dimension meanings independently of relationship roles', async () => {
    const source = await createCrux();
    const target = await createCrux();
    for (const type of ['gate', 'garden', 'growth', 'graft'] as const) {
      await dimensions.create({
        sourceId: source.id,
        targetId: target.id,
        type,
        authorId,
        homeId,
        meta: { type },
      });
    }
    const all = await dimensions.findBySourceIdAndTypeQuery(source.id);
    expect(all.map((d) => d.type).sort()).toEqual([
      'garden',
      'gate',
      'graft',
      'growth',
    ]);
  });

  it('encodes API values in the existing desktop format without rewriting opaque content', async () => {
    const crux = await createCrux();
    expect(crux.discoverable).toBe(false);
    expect(crux.created).toBeInstanceOf(Date);
    expect(crux.meta.nested).toEqual({
      camelCase: true,
      created: 'not a date',
    });
    const raw = await db
      .query()('cruxes')
      .where({ id: crux.id })
      .select({ metadata: 'meta', timestamp: 'created', flag: 'discoverable' })
      .first();
    expect(raw).toEqual({
      metadata: JSON.stringify(crux.meta),
      timestamp: crux.created.toISOString(),
      flag: 0,
    });
    expect((await cruxes.findBy('id', crux.id)).data.data).toBe(
      '{"keepThis":"opaque text"}',
    );
    const updated = await cruxes.update(crux.id, { discoverable: true });
    expect(updated.error).toBeNull();
    expect(updated.data.discoverable).toBe(true);
  });

  it('never replaces live or trashed work when creating a graph Crux', async () => {
    const original = await createCrux();
    for (const candidate of [
      { id: original.id, slug: 'different-slug' },
      { id: randomUUID(), slug: original.slug },
    ]) {
      await expect(
        graph.create({
          ...candidate,
          title: 'Do not replace',
          authorId,
          homeId,
        }),
      ).rejects.toThrow(ConflictException);
    }
    expect((await graph.findById(original.id)).title).toBe('A Garden');
    await db
      .query()('cruxes')
      .where({ id: original.id })
      .update({ deleted: new Date() });
    await expect(
      graph.create({ id: original.id, slug: original.slug, authorId, homeId }),
    ).rejects.toThrow(ConflictException);
    const preserved = await cruxes.findByIdIncludingDeleted(original.id);
    expect(preserved.data.deleted).toBeInstanceOf(Date);
    expect(preserved.data.title).toBe('A Garden');
  });

  it('allows only one winner when two creates race for the same slug', async () => {
    const slug = randomUUID();
    const results = await Promise.allSettled([
      graph.create({ slug, title: 'First', authorId, homeId }),
      graph.create({ slug, title: 'Second', authorId, homeId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    const rows = await db.query()('cruxes').where({ slug });
    expect(rows).toHaveLength(1);
  });

  it('uses the shared API update and lookup semantics without hosted providers', async () => {
    const original = await createCrux();
    const other = await createCrux();
    await expect(
      graph.update(original.id, { slug: other.slug }),
    ).rejects.toThrow('already in use');
    await graph.update(original.id, { title: 'Changed locally' });
    expect(
      await graph.findOwnedByIdentifier(original.id, authorId),
    ).toMatchObject({
      title: 'Changed locally',
    });
    expect(
      await graph.findByAuthorAndSlug(authorId, original.slug),
    ).toMatchObject({ id: original.id });
  });

  it('refuses an incomplete schema before applying compatibility changes', async () => {
    await db
      .query()
      .schema.alterTable('dimensions', (table) => table.dropColumn('deleted'));
    await db.query().schema.dropTable('authors');
    await expect(prepareDesktopGraph(db.query())).rejects.toThrow(
      'missing authors',
    );
    expect(await db.query().schema.hasColumn('dimensions', 'deleted')).toBe(
      false,
    );
    expect(
      await db.query()('settings').where({ key: 'keep-me' }).first(),
    ).toMatchObject({ value: 'unchanged' });
  });

  it('rolls back a failed SQLite transaction without changing existing records', async () => {
    await expect(
      db.query().transaction(async (trx) => {
        await trx('settings')
          .where({ key: 'keep-me' })
          .update({ value: 'changed' });
        await trx('settings').insert({
          key: 'new-value',
          value: 'not committed',
        });
        throw new Error('abort graph change');
      }),
    ).rejects.toThrow('abort graph change');
    expect(
      await db.query()('settings').where({ key: 'keep-me' }).first(),
    ).toMatchObject({ value: 'unchanged' });
    expect(
      await db.query()('settings').where({ key: 'new-value' }).first(),
    ).toBeUndefined();
  });

  it('reports corrupt persisted JSON instead of silently replacing metadata', async () => {
    const original = await createCrux();
    await db
      .query()('cruxes')
      .where({ id: original.id })
      .update({ meta: '{broken' });
    const result = await cruxes.findBy('id', original.id);
    expect(result.error).toBeTruthy();
    expect(result.data).toBeNull();
  });
});
