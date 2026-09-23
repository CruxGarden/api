import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned working-copy metadata update', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  let cruxId: string;
  const read = () =>
    owner.get<any>('SELECT * FROM working_copies WHERE id = ?', [id]);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-edit-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    cruxId = (
      await owner.execute(({ crux }) =>
        crux.create({
          slug: randomUUID(),
          authorId: randomUUID(),
          homeId: randomUUID(),
          title: 'Main',
        }),
      )
    ).id;
    id = randomUUID();
    await owner.run(
      'INSERT INTO working_copies (id, crux_id, task_id, title, base_snapshot_id, phase, meta, project_folder, revision, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        cruxId,
        randomUUID(),
        'Original task',
        randomUUID(),
        'ready',
        JSON.stringify({
          retained: true,
          nested: { old: true },
          projectFolder: '/stale',
          workingCopy: { stale: true },
        }),
        '/actual-folder',
        3,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('merges simultaneous patches, cleans reserved fields and preserves identity and revisions across restart', async () => {
    const before = await read();
    await Promise.all([
      owner.updateWorkingCopyMeta(
        id,
        { one: true, nested: { next: true }, workingCopy: { cruxId: 'wrong' } },
        '  Renamed  ',
      ),
      owner.updateWorkingCopyMeta(id, {
        two: true,
        nullable: null,
        projectFolder: '/wrong',
      }),
    ]);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const after = await read();
    expect(after).toMatchObject({
      id,
      crux_id: cruxId,
      title: 'Renamed',
      revision: 5,
      project_folder: '/actual-folder',
      task_id: before.task_id,
      base_snapshot_id: before.base_snapshot_id,
      phase: 'ready',
    });
    expect(JSON.parse(after.meta)).toEqual({
      retained: true,
      nested: { next: true },
      one: true,
      two: true,
      nullable: null,
    });
    expect(
      (await owner.execute(({ crux }) => crux.findById(cruxId))).title,
    ).toBe('Main');
    await owner.updateWorkingCopyMeta(id, {}, '   ');
    expect((await read()).title).toBe('Untitled task');
  });
  it('captures mutable input before queueing and drains accepted edits before close', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = owner.execute(async () => {
      await waiting;
    });
    const patch = { nested: { captured: true } };
    const edit = owner.updateWorkingCopyMeta(id, patch, 'Captured');
    patch.nested.captured = false;
    const closed = owner.close();
    await expect(owner.updateWorkingCopyMeta(id, {})).rejects.toThrow(
      'closing',
    );
    release();
    await Promise.all([blocker, edit, closed]);
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(JSON.parse((await read()).meta).nested).toEqual({ captured: true });
  });
  it.each(['ABORT', 'IGNORE'])(
    'rolls back all effects when SQLite refuses an update with %s, then permits retry',
    async (action) => {
      const before = await read();
      await owner.run("INSERT INTO settings VALUES ('untouched', 'yes')");
      await owner.run(
        `CREATE TRIGGER fail_task BEFORE UPDATE ON working_copies BEGIN DELETE FROM settings; SELECT RAISE(${action === 'ABORT' ? "ABORT, 'Injected task failure'" : 'IGNORE'}); END`,
      );
      await expect(
        owner.updateWorkingCopyMeta(id, { failed: true }, 'Failed'),
      ).rejects.toThrow(
        action === 'ABORT' ? 'Injected task failure' : 'changed while saving',
      );
      expect(await read()).toEqual(before);
      expect(await owner.get('SELECT value FROM settings')).toEqual({
        value: 'yes',
      });
      await owner.run('DROP TRIGGER fail_task');
      await owner.updateWorkingCopyMeta(id, { retried: true });
      expect((await read()).revision).toBe(4);
    },
  );
  it('refuses missing copies and missing/deleted owning Cruxes before changing the task', async () => {
    await expect(owner.updateWorkingCopyMeta(randomUUID(), {})).rejects.toThrow(
      'not found',
    );
    const before = await read();
    await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
      new Date().toISOString(),
      cruxId,
    ]);
    await expect(owner.updateWorkingCopyMeta(id, {}, 'No')).rejects.toThrow(
      'not found',
    );
    expect(await read()).toEqual(before);
    await owner.run('DELETE FROM cruxes WHERE id = ?', [cruxId]);
    await expect(owner.updateWorkingCopyMeta(id, {}, 'No')).rejects.toThrow(
      'not found',
    );
    expect(await read()).toEqual(before);
  });
  it('rejects invalid patches, titles and damaged stored metadata without poisoning the queue', async () => {
    const before = await read();
    for (const patch of [null, [], { value: 1n }, { toJSON: () => 'invalid' }])
      await expect(
        owner.updateWorkingCopyMeta(id, patch as any),
      ).rejects.toThrow();
    await expect(
      owner.updateWorkingCopyMeta(id, {}, 1 as any),
    ).rejects.toThrow();
    expect(await read()).toEqual(before);
    await owner.run('UPDATE working_copies SET meta = ? WHERE id = ?', [
      '[]',
      id,
    ]);
    await expect(
      owner.updateWorkingCopyMeta(id, { replaced: true }),
    ).rejects.toThrow('metadata');
    expect((await read()).meta).toBe('[]');
    await owner.run('UPDATE working_copies SET meta = ? WHERE id = ?', [
      before.meta,
      id,
    ]);
    await owner.run('UPDATE working_copies SET revision = ? WHERE id = ?', [
      -1,
      id,
    ]);
    await expect(
      owner.updateWorkingCopyMeta(id, { replaced: true }),
    ).rejects.toThrow('revision');
    expect((await read()).revision).toBe(-1);
    await owner.run('UPDATE working_copies SET revision = ? WHERE id = ?', [
      before.revision,
      id,
    ]);
    await owner.updateWorkingCopyMeta(id, { valid: true });
    expect(JSON.parse((await read()).meta).valid).toBe(true);
  });
  it('preserves closed-task and review metadata behavior without reopening or moving copies', async () => {
    await owner.run(
      "UPDATE working_copies SET phase = 'archived', role = 'review' WHERE id = ?",
      [id],
    );
    await owner.updateWorkingCopyMeta(id, { note: 'Kept' }, 'Review label');
    expect(await read()).toMatchObject({
      phase: 'archived',
      role: 'review',
      title: 'Review label',
      project_folder: '/actual-folder',
    });
  });
});
