import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';
import { LocalWorkingCopyCreate } from './working-copy-create';

describe('owned Task preparation and preview data', () => {
  let owner: LocalGraphRuntime;
  let dir: string;
  let input: LocalWorkingCopyCreate;
  let base: string;
  let store: DesktopContentStore;
  const sourceRows = () =>
    owner.all<any>('SELECT * FROM store WHERE crux_id = ? ORDER BY id', [
      input.cruxId,
    ]);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-create-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    const identity = { authorId: randomUUID(), homeId: randomUUID() };
    const main = await owner.createCrux({ ...identity, slug: 'main' });
    const objects = new Map<string, Uint8Array>();
    store = {
      read: async (id) => objects.get(id) ?? null,
      write: async (id, bytes) => {
        objects.set(id, bytes);
      },
    };
    const head = await owner.editFileContent(
      { cruxId: main, expected: null, changes: [] },
      store,
    );
    base = (
      await owner.createGrowthSnapshot(
        {
          cruxId: main,
          expected: head,
          snapshotId: randomUUID(),
          parentId: null,
        },
        store,
      )
    ).snapshot.id;
    await owner.updateCrux(main, {
      meta: { settings: { activeBranch: base } },
    });
    input = {
      id: randomUUID(),
      cruxId: main,
      taskId: randomUUID(),
      base: {
        expected: head,
        expectedMeta:
          (await owner.execute(({ crux }) => crux.findById(main))).meta ?? {},
      },
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
  it('registers a prepared folder then completes setup across restart without touching preview slots', async () => {
    await owner.createWorkingCopy(input, store);
    const preview = await owner.all('SELECT * FROM store ORDER BY id');
    const prepare = jest.fn(async (id, current) => {
      expect(id).toBe(input.id);
      expect(current).toBeNull();
      return '/prepared/task';
    });
    expect(await owner.prepareWorkingCopyFolder(input.id, 0, prepare)).toBe(
      '/prepared/task',
    );
    expect(
      await owner.get(
        'SELECT phase, revision, project_folder FROM working_copies WHERE id = ?',
        [input.id],
      ),
    ).toEqual({
      phase: 'preparing',
      revision: 1,
      project_folder: '/prepared/task',
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.finishWorkingCopySetup(input.id, 1, 'ready');
    expect(
      await owner.get(
        'SELECT phase, revision FROM working_copies WHERE id = ?',
        [input.id],
      ),
    ).toEqual({ phase: 'ready', revision: 2 });
    expect(await owner.all('SELECT * FROM store ORDER BY id')).toEqual(preview);
    await expect(
      owner.finishWorkingCopySetup(input.id, 1, 'failed'),
    ).rejects.toThrow();
    expect(
      await owner.get('SELECT phase FROM working_copies WHERE id = ?', [
        input.id,
      ]),
    ).toEqual({ phase: 'ready' });
  });
  it('rejects stale setup before invoking the folder hook and retains changes', async () => {
    await owner.createWorkingCopy(input, store);
    await owner.updateWorkingCopyMeta(input.id, { notes: 'Concurrent edit' });
    const before = await owner.get(
      'SELECT * FROM working_copies WHERE id = ?',
      [input.id],
    );
    const hook = jest.fn(() => '/unexpected');
    await expect(
      owner.prepareWorkingCopyFolder(input.id, 0, hook),
    ).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
    await expect(
      owner.finishWorkingCopySetup(input.id, 0, 'failed'),
    ).rejects.toThrow();
    expect(
      await owner.get('SELECT * FROM working_copies WHERE id = ?', [input.id]),
    ).toEqual(before);
  });
  it('retains a failed setup and its folder for guarded recovery', async () => {
    await owner.createWorkingCopy(input, store);
    await owner.prepareWorkingCopyFolder(input.id, 0, () => '/retained');
    await owner.finishWorkingCopySetup(input.id, 1, 'failed');
    expect(
      await owner.prepareWorkingCopyFolder(input.id, 2, (_id, current) => {
        expect(current).toBe('/retained');
        return current!;
      }),
    ).toBe('/retained');
    await owner.finishWorkingCopySetup(input.id, 3, 'ready');
    expect(
      await owner.get(
        'SELECT phase, revision, project_folder FROM working_copies WHERE id = ?',
        [input.id],
      ),
    ).toEqual({ phase: 'ready', revision: 4, project_folder: '/retained' });
  });
  it('refuses ready without a folder and keeps failed host preparation retryable', async () => {
    await owner.createWorkingCopy(input, store);
    const before = await owner.get(
      'SELECT * FROM working_copies WHERE id = ?',
      [input.id],
    );
    await expect(
      owner.finishWorkingCopySetup(input.id, 0, 'ready'),
    ).rejects.toThrow();
    await expect(
      owner.prepareWorkingCopyFolder(input.id, 0, () => {
        throw new Error('Disk full');
      }),
    ).rejects.toThrow('Disk full');
    expect(
      await owner.get('SELECT * FROM working_copies WHERE id = ?', [input.id]),
    ).toEqual(before);
  });
  it.each(['ABORT', 'IGNORE'])(
    'rolls back setup %s without undoing host files',
    async (action) => {
      await owner.createWorkingCopy(input, store);
      const before = await owner.get(
        'SELECT * FROM working_copies WHERE id = ?',
        [input.id],
      );
      await owner.run(
        `CREATE TRIGGER refuse_setup BEFORE UPDATE ON working_copies BEGIN SELECT RAISE(${action}${action === 'ABORT' ? ", 'Setup refused'" : ''}); END`,
      );
      const hook = jest.fn(() => '/prepared-but-unregistered');
      await expect(
        owner.prepareWorkingCopyFolder(input.id, 0, hook),
      ).rejects.toThrow();
      expect(hook).toHaveBeenCalledTimes(1);
      expect(
        await owner.get('SELECT * FROM working_copies WHERE id = ?', [
          input.id,
        ]),
      ).toEqual(before);
      await owner.run('DROP TRIGGER refuse_setup');
      await owner.prepareWorkingCopyFolder(input.id, 0, () => '/retry');
      await owner.run(
        `CREATE TRIGGER refuse_ready BEFORE UPDATE ON working_copies WHEN NEW.phase = 'ready' BEGIN SELECT RAISE(${action}${action === 'ABORT' ? ", 'Ready refused'" : ''}); END`,
      );
      const prepared = await owner.get(
        'SELECT * FROM working_copies WHERE id = ?',
        [input.id],
      );
      await expect(
        owner.finishWorkingCopySetup(input.id, 1, 'ready'),
      ).rejects.toThrow();
      expect(
        await owner.get('SELECT * FROM working_copies WHERE id = ?', [
          input.id,
        ]),
      ).toEqual(prepared);
    },
  );
  it.each(['task', 'review'] as const)(
    'creates a preparing %s and all isolated preview slots in one durable command',
    async (role) => {
      input.role = role;
      const original = await sourceRows();
      await owner.createWorkingCopy(input, store);
      const copy = await owner.get<any>(
        'SELECT * FROM working_copies WHERE id = ?',
        [input.id],
      );
      expect(copy).toMatchObject({
        id: input.id,
        crux_id: input.cruxId,
        task_id: input.taskId,
        base_state: JSON.stringify({
          root: input.base.expected!.root,
          workspace: { parentId: base, messages: [], entryFile: null },
        }),
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
      await expect(owner.createWorkingCopy(input, store)).rejects.toThrow();
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
      await owner.createWorkingCopy(input, store);
      expect(
        await owner.all('SELECT * FROM store WHERE crux_id = ?', [input.id]),
      ).toHaveLength(3);
    },
  );
  it('refuses identity collisions and duplicate creation without changing a prepared copy', async () => {
    await expect(
      owner.createWorkingCopy({ ...input, id: input.cruxId }, store),
    ).rejects.toThrow();
    await owner.createWorkingCopy(input, store);
    const copy = await owner.get('SELECT * FROM working_copies WHERE id = ?', [
      input.id,
    ]);
    await expect(
      owner.createWorkingCopy({ ...input, title: 'Overwrite' }, store),
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
    if (fault === 'snapshot-owner') input.cruxId = base;
    if (fault === 'unlinked-base') await owner.run('DELETE FROM dimensions');
    if (fault === 'deleted-base')
      await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
        new Date().toISOString(),
        base,
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
    await expect(owner.createWorkingCopy(input, store)).rejects.toThrow();
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
    const create = owner.createWorkingCopy(input, store);
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
    expect(JSON.parse(saved.meta).settings.activeBranch).toBe(base);
  });
});
