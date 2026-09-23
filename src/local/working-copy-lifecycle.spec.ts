import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned Task archive/reopen', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  let cruxId: string;
  const read = () =>
    owner.get<any>('SELECT * FROM working_copies WHERE id = ?', [id]);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-lifecycle-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    cruxId = await owner.createCrux({
      slug: 'main',
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
    id = randomUUID();
    await owner.run(
      'INSERT INTO working_copies (id, crux_id, task_id, title, base_snapshot_id, role, phase, meta, project_folder, revision, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        cruxId,
        randomUUID(),
        'My task',
        randomUUID(),
        'task',
        'ready',
        JSON.stringify({
          notes: 'Keep',
          settings: { activeBranch: 'history' },
        }),
        '/retained',
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
  it('archives in one write and reopens across restart without rewriting content, identity or metadata', async () => {
    const before = await read();
    const notices: unknown[] = [];
    owner.onChange((event) => {
      notices.push(event);
    });
    await owner.setWorkingCopyArchived(id, true, 3);
    expect(await read()).toMatchObject({
      ...before,
      phase: 'archived',
      revision: 4,
      updated: expect.any(String),
    });
    expect(notices).toMatchObject([
      { entity: 'working-copy', id, cruxId, fields: ['phase'] },
    ]);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.setWorkingCopyArchived(id, false, 4);
    expect(await read()).toMatchObject({
      ...before,
      phase: 'ready',
      revision: 5,
      updated: expect.any(String),
    });
  });
  it('refuses a stale revision after a queued edit without losing either change', async () => {
    const edit = owner.updateWorkingCopyMeta(id, { notes: 'Concurrent' });
    const archive = owner.setWorkingCopyArchived(id, true, 3);
    await edit;
    await expect(archive).rejects.toThrow('changed');
    expect(await read()).toMatchObject({ phase: 'ready', revision: 4 });
    expect(JSON.parse((await read()).meta).notes).toBe('Concurrent');
  });
  it.each(['merged', 'failed', 'preparing'])(
    'refuses %s Tasks without bypassing their own recovery workflow',
    async (phase) => {
      await owner.run('UPDATE working_copies SET phase = ? WHERE id = ?', [
        phase,
        id,
      ]);
      const before = await read();
      await expect(
        owner.setWorkingCopyArchived(id, false, 3),
      ).rejects.toThrow();
      expect(await read()).toEqual(before);
    },
  );
  it('refuses review copies and missing owners', async () => {
    await owner.run("UPDATE working_copies SET role = 'review' WHERE id = ?", [
      id,
    ]);
    await expect(owner.setWorkingCopyArchived(id, true, 3)).rejects.toThrow();
    await owner.run("UPDATE working_copies SET role = 'task' WHERE id = ?", [
      id,
    ]);
    await owner.setCruxTrashed(cruxId, true);
    await expect(owner.setWorkingCopyArchived(id, true, 3)).rejects.toThrow();
    expect((await read()).phase).toBe('ready');
  });
  it('rolls back silently ignored writes including trigger effects and allows retry', async () => {
    await owner.run(
      "CREATE TRIGGER ignore_archive BEFORE UPDATE ON working_copies BEGIN INSERT INTO settings (key, value) VALUES ('should-rollback', 'yes'); SELECT RAISE(IGNORE); END",
    );
    const before = await read();
    const notices: unknown[] = [];
    owner.onChange((event) => {
      notices.push(event);
    });
    await expect(owner.setWorkingCopyArchived(id, true, 3)).rejects.toThrow();
    expect(await read()).toEqual(before);
    expect(
      await owner.get(
        "SELECT value FROM settings WHERE key = 'should-rollback'",
      ),
    ).toBeUndefined();
    expect(notices).toEqual([]);
    await owner.run('DROP TRIGGER ignore_archive');
    await owner.setWorkingCopyArchived(id, true, 3);
    expect((await read()).phase).toBe('archived');
  });
  it('rolls back a late trigger rewrite instead of reporting success', async () => {
    await owner.run(
      "CREATE TRIGGER revert_archive AFTER UPDATE ON working_copies BEGIN UPDATE working_copies SET phase = 'ready' WHERE id = NEW.id; END",
    );
    const before = await read();
    await expect(owner.setWorkingCopyArchived(id, true, 3)).rejects.toThrow();
    expect(await read()).toEqual(before);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, NaN])(
    'rejects invalid revisions: %s',
    async (revision) => {
      await expect(
        owner.setWorkingCopyArchived(id, true, revision),
      ).rejects.toThrow();
      expect((await read()).revision).toBe(3);
    },
  );
});
