import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned Crux lifecycle', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-lifecycle-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    id = (
      await owner.execute(({ crux }) =>
        crux.create({
          slug: randomUUID(),
          authorId: randomUUID(),
          homeId: randomUUID(),
        }),
      )
    ).id;
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('rolls back the entire purge on a late failure, then retries without losing unrelated work', async () => {
    await owner.run(
      'INSERT INTO store (id, crux_id, key, value, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        id,
        'private',
        'kept until commit',
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await owner.run(
      "CREATE TRIGGER refuse_purge BEFORE DELETE ON cruxes BEGIN SELECT RAISE(ABORT, 'No purge'); END",
    );
    const changes: unknown[] = [];
    owner.onChange((change) => {
      changes.push(change);
    });
    await expect(owner.deleteCrux(id)).rejects.toThrow('No purge');
    expect(
      await owner.get('SELECT value FROM store WHERE crux_id = ?', [id]),
    ).toEqual({ value: 'kept until commit' });
    expect(await owner.get('SELECT id FROM cruxes WHERE id = ?', [id])).toEqual(
      { id },
    );
    expect(changes).toEqual([]);
    await owner.run('DROP TRIGGER refuse_purge');
    await owner.deleteCrux(id);
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [id]),
    ).toBeUndefined();
    expect(
      await owner.get('SELECT value FROM store WHERE crux_id = ?', [id]),
    ).toBeUndefined();
    expect(changes).toMatchObject([
      { entity: 'crux-lifecycle', id, operation: 'purge' },
    ]);
  });
  async function create(meta: Record<string, unknown> = {}, kind?: string) {
    return owner.execute(({ crux }) =>
      crux.create({
        slug: randomUUID(),
        authorId: randomUUID(),
        homeId: randomUUID(),
        meta,
        kind: kind as any,
      }),
    );
  }
  async function link(source: string, target: string, type: string) {
    return owner.execute(({ dimension }) =>
      dimension.create({
        sourceId: source,
        targetId: target,
        type: type as any,
        authorId: randomUUID(),
        homeId: randomUUID(),
      }),
    );
  }
  it('preserves shared members, history ancestry and foreign-owned snapshots while deleting only owned records', async () => {
    const other = await create();
    const member = await create();
    await link(id, member.id, 'garden');
    const keptLink = await link(other.id, member.id, 'garden');
    const base = await create({}, 'snapshot');
    const shared = await create({ parentCruxId: base.id }, 'snapshot');
    const own = await create({}, 'snapshot');
    const foreign = await create({ contentOwnerId: other.id }, 'snapshot');
    for (const snapshot of [base, shared, own, foreign])
      await link(id, snapshot.id, 'growth');
    await link(other.id, shared.id, 'graft');
    await owner.deleteCrux(id);
    for (const retained of [other, member, base, shared, foreign])
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [retained.id]),
      ).toEqual({ id: retained.id });
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [own.id]),
    ).toBeUndefined();
    expect(
      await owner.get('SELECT id FROM dimensions WHERE id = ?', [keptLink.id]),
    ).toEqual({ id: keptLink.id });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [member.id]),
    ).toEqual({ id: member.id });
    await owner.deleteCrux(id); // retry after an already completed purge is safe
  });
  it('refuses direct deletion of Task copies and history referenced by another Task', async () => {
    const base = await create({}, 'snapshot');
    await link(id, base.id, 'growth');
    const task = randomUUID();
    await owner.run(
      'INSERT INTO working_copies (id, crux_id, task_id, title, base_state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        task,
        id,
        randomUUID(),
        'Task',
        JSON.stringify({
          root: 'a'.repeat(64),
          workspace: { parentId: base.id, messages: [], entryFile: null },
        }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await expect(owner.deleteCrux(task)).rejects.toThrow('belongs to Main');
    await expect(owner.deleteCrux(base.id)).rejects.toThrow('used by a task');
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [base.id]),
    ).toEqual({ id: base.id });
    await expect(owner.deleteCrux('')).rejects.toThrow('identity');
  });
  it('rejects silently ignored deletions and rolls back earlier steps', async () => {
    await owner.run(
      'INSERT INTO store (id, crux_id, key, value, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        id,
        'private',
        'retained',
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await owner.run(
      'CREATE TRIGGER ignore_purge BEFORE DELETE ON cruxes BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(owner.deleteCrux(id)).rejects.toThrow(
      'Incomplete Crux deletion',
    );
    expect(
      await owner.get('SELECT value FROM store WHERE crux_id = ?', [id]),
    ).toEqual({ value: 'retained' });
  });
  it('trashes and restores the same identity without touching its graph or stored content', async () => {
    const member = await create();
    const edge = await link(id, member.id, 'garden');
    const changes: unknown[] = [];
    owner.onChange((change) => {
      changes.push(change);
    });
    await owner.setCruxTrashed(id, true);
    const deleted = (await owner.get<{ deleted: string }>(
      'SELECT deleted FROM cruxes WHERE id = ?',
      [id],
    ))!.deleted;
    expect(deleted).toBeTruthy();
    await owner.setCruxTrashed(id, true);
    expect(
      (await owner.get<{ deleted: string }>(
        'SELECT deleted FROM cruxes WHERE id = ?',
        [id],
      ))!.deleted,
    ).toBe(deleted);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(
      (await owner.get<{ deleted: string }>(
        'SELECT deleted FROM cruxes WHERE id = ?',
        [id],
      ))!.deleted,
    ).toBe(deleted);
    await owner.run(
      "CREATE TRIGGER refuse_restore BEFORE UPDATE OF deleted ON cruxes BEGIN SELECT RAISE(ABORT, 'No restore'); END",
    );
    await expect(owner.setCruxTrashed(id, false)).rejects.toThrow('No restore');
    expect(
      (await owner.get<{ deleted: string }>(
        'SELECT deleted FROM cruxes WHERE id = ?',
        [id],
      ))!.deleted,
    ).toBe(deleted);
    await owner.run('DROP TRIGGER refuse_restore');
    await owner.setCruxTrashed(id, false);
    expect(
      await owner.get('SELECT deleted FROM cruxes WHERE id = ?', [id]),
    ).toEqual({ deleted: null });
    expect(
      await owner.get('SELECT id FROM dimensions WHERE id = ?', [edge.id]),
    ).toEqual({ id: edge.id });
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [member.id]),
    ).toEqual({ id: member.id });
    expect(changes).toMatchObject([
      { entity: 'crux-lifecycle', operation: 'trash', id },
      { operation: 'trash' },
    ]);
    await expect(owner.setCruxTrashed(id, 'yes' as any)).rejects.toThrow();
  });
  it.each([
    'artifacts',
    'store',
    'dimensions',
    'working_copies',
    'task_merges',
  ])('rolls back every table when %s silently keeps a row', async (table) => {
    const now = new Date().toISOString(),
      task = randomUUID();
    await owner.run(
      'INSERT INTO working_copies (id, crux_id, task_id, title, base_state, phase, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        task,
        id,
        randomUUID(),
        'Task',
        JSON.stringify({
          root: 'a'.repeat(64),
          workspace: { parentId: null, messages: [], entryFile: null },
        }),
        'archived',
        now,
        now,
      ],
    );
    await owner.run(
      'INSERT INTO task_merges (id, crux_id, copy_id, candidate_id, phase, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), id, task, randomUUID(), 'cancelled', '{}', now],
    );
    await owner.run(
      'INSERT INTO artifacts (id, resource_id, author_id, home_id, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), task, randomUUID(), randomUUID(), now, now],
    );
    await owner.run(
      'INSERT INTO store (id, crux_id, key, value, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), task, 'state', 'saved', now, now],
    );
    const related = await create();
    await link(id, related.id, 'garden');
    const tables = [
      'cruxes',
      'artifacts',
      'store',
      'dimensions',
      'working_copies',
      'task_merges',
    ];
    const before = await Promise.all(
      tables.map((t) => owner.all(`SELECT * FROM ${t} ORDER BY id`)),
    );
    await owner.run(
      `CREATE TRIGGER ignore_purge BEFORE DELETE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
    );
    await expect(owner.deleteCrux(id)).rejects.toThrow(
      'Incomplete Crux deletion',
    );
    expect(
      await Promise.all(
        tables.map((t) => owner.all(`SELECT * FROM ${t} ORDER BY id`)),
      ),
    ).toEqual(before);
    await owner.run('DROP TRIGGER ignore_purge');
    await owner.deleteCrux(id);
    for (const t of [
      'working_copies',
      'task_merges',
      'artifacts',
      'store',
      'dimensions',
    ])
      expect(await owner.all(`SELECT * FROM ${t}`)).toEqual([]);
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [related.id]),
    ).toEqual({ id: related.id });
  });
  it('keeps external Task ancestry while collecting the deleted owner’s closed Task history', async () => {
    const other = await create();
    const base = await create({}, 'snapshot');
    const tip = await create({ parentCruxId: base.id }, 'snapshot');
    await link(id, base.id, 'growth');
    await link(id, tip.id, 'growth');
    const now = new Date().toISOString(),
      task = randomUUID(),
      external = randomUUID();
    for (const [copy, parent, snapshot] of [
      [task, id, base.id],
      [external, other.id, tip.id],
    ])
      await owner.run(
        'INSERT INTO working_copies (id, crux_id, task_id, title, base_state, phase, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          copy,
          parent,
          randomUUID(),
          'Task',
          JSON.stringify({
            root: 'a'.repeat(64),
            workspace: { parentId: snapshot, messages: [], entryFile: null },
          }),
          'archived',
          now,
          now,
        ],
      );
    const ownedTip = await create({ contentOwnerId: task }, 'snapshot');
    await link(task, ownedTip.id, 'growth');
    await owner.deleteCrux(id);
    for (const kept of [base, tip])
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [kept.id]),
      ).toEqual({ id: kept.id });
    expect(
      await owner.get('SELECT id FROM working_copies WHERE id = ?', [external]),
    ).toEqual({ id: external });
    expect(
      await owner.get('SELECT id FROM working_copies WHERE id = ?', [task]),
    ).toBeUndefined();
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [ownedTip.id]),
    ).toBeUndefined();
  });
  it('rolls back earlier chunks when a large history fails in its final chunk', async () => {
    await owner.execute(async ({ crux, dimension }) => {
      for (let n = 1; n <= 205; n++) {
        const snapshot = await crux.create({
          id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
          slug: randomUUID(),
          authorId: randomUUID(),
          homeId: randomUUID(),
          kind: 'snapshot' as any,
        });
        await dimension.create({
          sourceId: id,
          targetId: snapshot.id,
          type: 'growth' as any,
          authorId: randomUUID(),
          homeId: randomUUID(),
        });
      }
    });
    await owner.run(
      `CREATE TRIGGER refuse_last BEFORE DELETE ON cruxes WHEN OLD.id = '${id}' BEGIN SELECT RAISE(ABORT, 'Final chunk failed'); END`,
    );
    await expect(owner.deleteCrux(id)).rejects.toThrow('Final chunk failed');
    expect((await owner.all('SELECT id FROM cruxes')).length).toBe(206);
    expect((await owner.all('SELECT id FROM dimensions')).length).toBe(205);
    await owner.run('DROP TRIGGER refuse_last');
    await owner.deleteCrux(id);
    expect(await owner.all('SELECT id FROM cruxes')).toEqual([]);
    expect(await owner.all('SELECT id FROM dimensions')).toEqual([]);
  });
  it.each(['candidate_id', 'baseId'])(
    'refuses deleting history pinned by a merge’s %s even when it has the same owner',
    async (field) => {
      const snapshot = await create({}, 'snapshot');
      await link(id, snapshot.id, 'growth');
      await owner.run(
        'INSERT INTO task_merges (id, crux_id, copy_id, candidate_id, phase, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          randomUUID(),
          id,
          randomUUID(),
          field === 'candidate_id' ? snapshot.id : randomUUID(),
          'applying',
          JSON.stringify(field === 'baseId' ? { baseId: snapshot.id } : {}),
          new Date().toISOString(),
        ],
      );
      await expect(owner.deleteCrux(snapshot.id)).rejects.toThrow(
        'used by a task, merge or recovery copy',
      );
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [snapshot.id]),
      ).toEqual({ id: snapshot.id });
    },
  );
});
