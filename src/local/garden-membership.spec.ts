import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { CruxKind, DimensionType } from '../common/types/enums';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);
const authorId = randomUUID();
const homeId = randomUUID();

describe('local Garden membership domain operations', () => {
  let scratch: string;
  let filename: string;
  let runtime: LocalGraphRuntime;
  const create = (kind = CruxKind.GARDEN) =>
    runtime.execute(({ crux }) =>
      crux.create({
        slug: randomUUID(),
        kind,
        authorId,
        homeId,
        title: kind,
        data: 'Do not load this payload for navigation',
      }),
    );
  const add = (gardenId: string, memberId: string) =>
    runtime.addGardenMember({ gardenId, memberId, authorId, homeId });

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crux-membership-'));
    filename = join(scratch, 'garden.db');
    const seed = new Database(filename);
    seed.exec(schema);
    seed.close();
    runtime = await LocalGraphRuntime.open(filename);
  });
  afterEach(async () => {
    await runtime?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('gives nested Gardens and creative Cruxes one location while lateral Grafts stay out of contents', async () => {
    const root = await create();
    const child = await create();
    const sibling = await create();
    const work = await create(CruxKind.WEBAPP);
    await add(root.id, child.id);
    await add(root.id, sibling.id);
    const edge = await add(child.id, work.id);
    await expect(add(sibling.id, work.id)).rejects.toThrow('already planted');
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: sibling.id,
        targetId: work.id,
        type: DimensionType.GRAFT,
        authorId,
        homeId,
      }),
    );
    expect(edge).toMatchObject({
      sourceId: child.id,
      targetId: work.id,
      type: 'garden',
      kind: 'membership',
    });
    expect((await runtime.listGardenMembers(child.id)).items).toEqual([
      { id: work.id, slug: work.slug, title: work.title, kind: work.kind },
    ]);
    expect((await runtime.listGardenMembers(sibling.id)).items).toEqual([]);
    expect(await runtime.all('SELECT id FROM cruxes')).toHaveLength(4);
  });

  it('makes repeated and concurrent adds idempotent through the owner transaction', async () => {
    const garden = await create();
    const member = await create(CruxKind.NOTES);
    const edges = await Promise.all(
      Array.from({ length: 12 }, () => add(garden.id, member.id)),
    );
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(1);
    expect(await runtime.all('SELECT id FROM dimensions')).toHaveLength(1);
  });

  it('keeps the installation root parentless', async () => {
    const root = await runtime.enterLocalGarden();
    const other = await create();
    await expect(add(other.id, root.id)).rejects.toThrow('root');
    expect(await runtime.gardenParents(root.id)).toEqual([]);
  });

  it('refuses a move without inspected parents and preserves its placement', async () => {
    const a = await create();
    const b = await create();
    const work = await create(CruxKind.NOTES);
    await add(a.id, work.id);
    await expect(
      runtime.moveGardenMember({
        gardenId: b.id,
        memberId: work.id,
        authorId,
        homeId,
        expectedParents: undefined as unknown as string[],
      }),
    ).rejects.toThrow('Inspect');
    expect((await runtime.gardenParents(work.id)).map((row) => row.id)).toEqual(
      [a.id],
    );
  });

  it('projects Gates as parent arrays and moves one placement atomically with stale-parent refusal', async () => {
    const a = await create();
    const b = await create();
    const work = await create(CruxKind.NOTES);
    const original = await add(a.id, work.id);
    expect(await runtime.gardenParents(work.id)).toEqual([
      {
        id: a.id,
        title: a.title,
        slug: a.slug,
        kind: a.kind,
        edgeId: original.id,
        available: true,
      },
    ]);
    await runtime.run(`CREATE TRIGGER refuse_move BEFORE INSERT ON dimensions
      WHEN NEW.source_id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'refused move'); END`);
    const move = {
      gardenId: b.id,
      memberId: work.id,
      expectedParents: [a.id],
      authorId,
      homeId,
    };
    await expect(runtime.moveGardenMember(move)).rejects.toThrow(
      'refused move',
    );
    expect((await runtime.listGardenMembers(a.id)).items[0].id).toBe(work.id);
    await runtime.run('DROP TRIGGER refuse_move');
    const moved = await runtime.moveGardenMember(move);
    expect(moved.targetId).toBe(work.id);
    expect((await runtime.listGardenMembers(a.id)).items).toEqual([]);
    expect((await runtime.gardenParents(work.id)).map((row) => row.id)).toEqual(
      [b.id],
    );
    await expect(runtime.moveGardenMember(move)).rejects.toThrow(
      'location changed',
    );
    await runtime.close();
    runtime = await LocalGraphRuntime.open(filename);
    expect((await runtime.gardenParents(work.id)).map((row) => row.id)).toEqual(
      [b.id],
    );
    expect(await runtime.all('SELECT id FROM cruxes')).toHaveLength(3);
  });

  it('refuses an ignored placement removal without falsely reporting a successful move', async () => {
    const a = await create();
    const b = await create();
    const work = await create(CruxKind.NOTES);
    await add(a.id, work.id);
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: b.id,
        targetId: work.id,
        type: DimensionType.GARDEN,
        kind: 'membership',
        authorId,
        homeId,
      }),
    );
    await runtime.run(`CREATE TRIGGER ignore_move BEFORE UPDATE ON dimensions
      BEGIN SELECT RAISE(IGNORE); END`);
    await expect(
      runtime.moveGardenMember({
        gardenId: b.id,
        memberId: work.id,
        expectedParents: [a.id, b.id],
        authorId,
        homeId,
      }),
    ).rejects.toThrow();
    expect(
      (await runtime.gardenParents(work.id)).map((row) => row.id).sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('keeps unrestricted shared data readable and lets an explicit move settle its location', async () => {
    const a = await create();
    const b = await create();
    const work = await create(CruxKind.NOTES);
    await add(a.id, work.id);
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: b.id,
        targetId: work.id,
        type: DimensionType.GARDEN,
        kind: 'membership',
        authorId,
        homeId,
      }),
    );
    expect(
      (await runtime.gardenParents(work.id)).map((row) => row.id).sort(),
    ).toEqual([a.id, b.id].sort());
    await runtime.moveGardenMember({
      gardenId: b.id,
      memberId: work.id,
      expectedParents: [a.id, b.id],
      authorId,
      homeId,
    });
    expect((await runtime.gardenParents(work.id)).map((row) => row.id)).toEqual(
      [b.id],
    );
  });

  it('captures a queued command’s owner before navigation changes the caller’s input', async () => {
    const a = await create();
    const b = await create();
    const work = await create(CruxKind.NOTES);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = runtime.execute(async () => {
      await barrier;
    });
    const input = { gardenId: a.id, memberId: work.id, authorId, homeId };
    const pending = runtime.addGardenMember(input);
    input.gardenId = b.id;
    release();
    await blocker;
    await pending;
    expect((await runtime.listGardenMembers(a.id)).items[0].id).toBe(work.id);
    expect((await runtime.listGardenMembers(b.id)).items).toEqual([]);
  });

  it('rejects self and multi-step containment cycles but permits nonmembership graph cycles', async () => {
    const a = await create();
    const b = await create();
    const c = await create();
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: b.id,
        targetId: a.id,
        type: DimensionType.GRAFT,
        authorId,
        homeId,
      }),
    );
    await add(a.id, b.id); // Opposite Graft is not containment.
    await add(b.id, c.id);
    await expect(add(c.id, a.id)).rejects.toThrow('cycle');
    await expect(add(a.id, a.id)).rejects.toThrow('itself');
    expect((await runtime.listGardenMembers(c.id)).items).toEqual([]);
    expect(await runtime.all('SELECT id FROM dimensions')).toHaveLength(3);
  });

  it('terminates cycle checks even when unrestricted graph edges already form a cycle', async () => {
    const a = await create();
    const b = await create();
    const root = await create();
    for (const [sourceId, targetId] of [
      [a.id, b.id],
      [b.id, a.id],
    ])
      await runtime.execute(({ dimension }) =>
        dimension.create({
          sourceId,
          targetId,
          type: DimensionType.GARDEN,
          kind: 'membership',
          authorId,
          homeId,
        }),
      );
    await expect(add(root.id, a.id)).rejects.toThrow('already planted');
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: root.id,
        targetId: a.id,
        type: DimensionType.GARDEN,
        kind: 'membership',
        authorId,
        homeId,
      }),
    );
    await expect(add(b.id, root.id)).rejects.toThrow('cycle');
  });

  it('unlinks only membership, preserving other relations, shared members and artifacts across restart', async () => {
    const a = await create();
    const b = await create();
    const work = await create(CruxKind.WEBAPP);
    const edge = await add(a.id, work.id);
    // Generic graph storage remains unrestricted; existing shared data stays removable.
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: b.id,
        targetId: work.id,
        type: DimensionType.GARDEN,
        kind: 'membership',
        authorId,
        homeId,
      }),
    );
    const derivation = await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: a.id,
        targetId: work.id,
        type: DimensionType.GARDEN,
        kind: 'derivation',
        authorId,
        homeId,
      }),
    );
    await runtime.run(
      'INSERT INTO artifacts (id, resource_id, author_id, home_id, path, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        work.id,
        authorId,
        homeId,
        'keep.txt',
        '2026-09-22T00:00:00.000Z',
        '2026-09-22T00:00:00.000Z',
      ],
    );
    expect(await runtime.removeGardenMember(a.id, work.id)).toEqual({
      removed: 1,
    });
    expect(await runtime.removeGardenMember(a.id, work.id)).toEqual({
      removed: 0,
    });
    await runtime.close();
    runtime = await LocalGraphRuntime.open(filename);
    expect((await runtime.listGardenMembers(a.id)).items).toEqual([]);
    expect((await runtime.listGardenMembers(b.id)).items[0].id).toBe(work.id);
    expect(
      await runtime.get('SELECT deleted FROM dimensions WHERE id = ?', [
        edge.id,
      ]),
    ).toMatchObject({ deleted: expect.any(String) });
    expect(
      await runtime.get('SELECT deleted FROM dimensions WHERE id = ?', [
        derivation.id,
      ]),
    ).toEqual({ deleted: null });
    expect(
      await runtime.all('SELECT path FROM artifacts WHERE resource_id = ?', [
        work.id,
      ]),
    ).toEqual([{ path: 'keep.txt' }]);
    await expect(add(a.id, work.id)).rejects.toThrow('already planted');
    await runtime.removeGardenMember(b.id, work.id);
    // Re-add creates a new live edge; prior removal remains a tombstone.
    expect((await add(a.id, work.id)).id).not.toBe(edge.id);
  });

  it('does not navigate derivation, untyped Garden links, history or trashed targets', async () => {
    const garden = await create();
    const visible = await create(CruxKind.NOTES);
    const hidden = await create();
    await add(garden.id, visible.id);
    for (const kind of ['derivation', undefined])
      await runtime.execute(({ dimension }) =>
        dimension.create({
          sourceId: garden.id,
          targetId: hidden.id,
          type: DimensionType.GARDEN,
          kind,
          authorId,
          homeId,
        }),
      );
    expect(
      (await runtime.listGardenMembers(garden.id)).items.map(
        (member) => member.id,
      ),
    ).toEqual([visible.id]);
    await runtime.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
      '2026-09-22T00:00:00.000Z',
      visible.id,
    ]);
    expect((await runtime.listGardenMembers(garden.id)).items).toEqual([]);
    await expect(add(garden.id, visible.id)).rejects.toThrow('not found');
    expect(await runtime.removeGardenMember(garden.id, visible.id)).toEqual({
      removed: 1,
    });
  });

  it('validates endpoint kind, existence and identifiers before writing', async () => {
    const garden = await create();
    const work = await create(CruxKind.WEBAPP);
    await expect(add(work.id, garden.id)).rejects.toThrow('Garden');
    await expect(add(garden.id, randomUUID())).rejects.toThrow('not found');
    await expect(add(garden.id, 'not-an-id')).rejects.toThrow('identity');
    await runtime.run("UPDATE cruxes SET kind = 'snapshot' WHERE id = ?", [
      work.id,
    ]);
    await expect(add(garden.id, work.id)).rejects.toThrow('Snapshots');
    expect(await runtime.all('SELECT * FROM dimensions')).toEqual([]);
  });

  it('paginates member identities without returning payloads or metadata', async () => {
    const garden = await create();
    const members = await Promise.all([create(), create(), create()]);
    for (const member of members) await add(garden.id, member.id);
    const first = await runtime.listGardenMembers(garden.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await runtime.listGardenMembers(garden.id, {
      limit: 2,
      after: first.next,
    });
    expect(second.next).toBeNull();
    expect(
      [...first.items, ...second.items].map((member) => member.id),
    ).toEqual(members.map((member) => member.id).sort());
    expect(Object.keys(first.items[0]).sort()).toEqual([
      'id',
      'kind',
      'slug',
      'title',
    ]);
    await expect(
      runtime.listGardenMembers(garden.id, { limit: 101 }),
    ).rejects.toThrow('page size');
  });

  it('rolls back creation and membership as one complete command', async () => {
    const root = await create();
    await expect(
      runtime.execute(async ({ crux, garden }) => {
        const child = await crux.create({
          slug: randomUUID(),
          authorId,
          homeId,
          kind: CruxKind.GARDEN,
        });
        await garden.add({
          gardenId: root.id,
          memberId: child.id,
          authorId,
          homeId,
        });
        throw new Error('Interrupted creation');
      }),
    ).rejects.toThrow('Interrupted creation');
    expect(await runtime.all('SELECT id FROM cruxes')).toEqual([
      { id: root.id },
    ]);
    expect((await runtime.listGardenMembers(root.id)).items).toEqual([]);
  });
});
