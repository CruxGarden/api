import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { LocalWorkingCopyCreate } from './working-copy-create';

describe('owned Task preparation and preview data', () => {
  let owner: LocalGraphRuntime;
  let dir: string;
  let input: LocalWorkingCopyCreate;
  const sourceRows = () =>
    owner.all<any>('SELECT * FROM store WHERE crux_id = ? ORDER BY id', [
      input.cruxId,
    ]);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-create-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    const identity = { authorId: randomUUID(), homeId: randomUUID() };
    const main = await owner.createCrux({ ...identity, slug: 'main' });
    const base = await owner.createCrux({
      ...identity,
      slug: 'base',
      kind: 'snapshot',
    });
    await owner.execute(({ dimension }) =>
      dimension.create({
        ...identity,
        sourceId: main,
        targetId: base,
        type: 'growth' as any,
      }),
    );
    input = {
      id: randomUUID(),
      cruxId: main,
      taskId: randomUUID(),
      baseSnapshotId: base,
      title: 'My task',
      role: 'task',
      meta: {
        settings: { activeBranch: base },
        messages: [{ content: 'Keep me' }],
        extension: { retained: [1, 'two'] },
      },
    };
    await owner.run('ALTER TABLE store ADD COLUMN extension TEXT');
    for (const [index, visitor] of [
      null,
      randomUUID(),
      randomUUID(),
    ].entries()) {
      await owner.run(
        'INSERT INTO store (id, crux_id, visitor_id, key, value, mode, created, updated, extension) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          randomUUID(),
          main,
          visitor,
          'shared-key',
          `{"slot": ${index}, "bytes": "preserved"}`,
          visitor ? 'protected' : 'public',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          `opaque-${index}`,
        ],
      );
    }
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it.each(['task', 'review'] as const)(
    'creates a preparing %s and all isolated preview slots in one durable command',
    async (role) => {
      input.role = role;
      const original = await sourceRows();
      await owner.createWorkingCopy(input);
      const copy = await owner.get<any>(
        'SELECT * FROM working_copies WHERE id = ?',
        [input.id],
      );
      expect(copy).toMatchObject({
        id: input.id,
        crux_id: input.cruxId,
        task_id: input.taskId,
        base_snapshot_id: input.baseSnapshotId,
        role,
        phase: 'preparing',
        revision: 0,
        project_folder: null,
      });
      expect(JSON.parse(copy.meta)).toEqual(input.meta);
      const cloned = await owner.all<any>(
        'SELECT * FROM store WHERE crux_id = ?',
        [input.id],
      );
      expect(cloned).toHaveLength(original.length);
      for (const row of original) {
        const clone = cloned.find(
          (value) => value.visitor_id === row.visitor_id,
        )!;
        expect(clone.id).not.toBe(row.id);
        expect(clone).toEqual({ ...row, id: clone.id, crux_id: input.id });
      }
      expect(await sourceRows()).toEqual(original);
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      expect(
        await owner.get('SELECT * FROM working_copies WHERE id = ?', [
          input.id,
        ]),
      ).toEqual(copy);
      await owner.run('UPDATE store SET value = ? WHERE crux_id = ?', [
        '"preview only"',
        input.id,
      ]);
      expect(await sourceRows()).toEqual(original);
    },
  );
  it.each(['ABORT', 'IGNORE'])(
    'rolls back the entire copy on a late Store %s, then retries without duplicates',
    async (action) => {
      const original = await sourceRows();
      await owner.run(
        `CREATE TRIGGER refuse_clone BEFORE INSERT ON store WHEN NEW.crux_id = '${input.id}' AND NEW.extension = 'opaque-2' BEGIN SELECT RAISE(${action}${action === 'ABORT' ? ", 'Preview copy refused'" : ''}); END`,
      );
      await expect(owner.createWorkingCopy(input)).rejects.toThrow();
      expect(
        await owner.get('SELECT * FROM working_copies WHERE id = ?', [
          input.id,
        ]),
      ).toBeUndefined();
      expect(
        await owner.all('SELECT * FROM store WHERE crux_id = ?', [input.id]),
      ).toEqual([]);
      expect(await sourceRows()).toEqual(original);
      await owner.run('DROP TRIGGER refuse_clone');
      await owner.createWorkingCopy(input);
      expect(
        await owner.all('SELECT * FROM store WHERE crux_id = ?', [input.id]),
      ).toHaveLength(3);
    },
  );
  it('refuses identity collisions and duplicate creation without changing a prepared copy', async () => {
    await expect(
      owner.createWorkingCopy({ ...input, id: input.cruxId }),
    ).rejects.toThrow();
    await owner.createWorkingCopy(input);
    const copy = await owner.get('SELECT * FROM working_copies WHERE id = ?', [
      input.id,
    ]);
    await expect(
      owner.createWorkingCopy({ ...input, title: 'Overwrite' }),
    ).rejects.toThrow();
    expect(
      await owner.get('SELECT * FROM working_copies WHERE id = ?', [input.id]),
    ).toEqual(copy);
  });
  it.each([
    'missing-owner',
    'snapshot-owner',
    'unlinked-base',
    'deleted-base',
    'applying-merge',
  ])('refuses %s before inserting a copy', async (fault) => {
    if (fault === 'missing-owner')
      await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
        new Date().toISOString(),
        input.cruxId,
      ]);
    if (fault === 'snapshot-owner') input.cruxId = input.baseSnapshotId;
    if (fault === 'unlinked-base') await owner.run('DELETE FROM dimensions');
    if (fault === 'deleted-base')
      await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
        new Date().toISOString(),
        input.baseSnapshotId,
      ]);
    if (fault === 'applying-merge')
      await owner.run(
        "INSERT INTO task_merges VALUES (?, ?, ?, ?, 'applying', '{}', ?)",
        [
          randomUUID(),
          input.cruxId,
          randomUUID(),
          randomUUID(),
          new Date().toISOString(),
        ],
      );
    await expect(owner.createWorkingCopy(input)).rejects.toThrow();
    expect(
      await owner.get('SELECT * FROM working_copies WHERE id = ?', [input.id]),
    ).toBeUndefined();
  });
  it('captures input before the command queue waits', async () => {
    let unblock!: () => void;
    const block = owner.execute(
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const create = owner.createWorkingCopy(input);
    (input.meta.settings as any).activeBranch = 'changed';
    input.title = 'Changed later';
    unblock();
    await block;
    await create;
    const saved = await owner.get<any>(
      'SELECT title, meta FROM working_copies WHERE id = ?',
      [input.id],
    );
    expect(saved.title).toBe('My task');
    expect(JSON.parse(saved.meta).settings.activeBranch).toBe(
      input.baseSnapshotId,
    );
  });
});
