import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('committed local graph notifications', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-notify-'));
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
  it('emits ordered, immutable invalidations after commits and permits subscriber reads', async () => {
    const changes: any[] = [];
    const reads: Promise<any>[] = [];
    owner.onChange((change) => {
      changes.push(change);
      reads.push(owner.get('SELECT title FROM cruxes WHERE id = ?', [id]));
    });
    await owner.updateCrux(id, {
      title: 'Committed',
      meta: { secret: 'private payload' },
    });
    await Promise.all(reads);
    expect(await reads[0]).toEqual({ title: 'Committed' });
    await owner.mergeCruxMeta(id, { next: true });
    await Promise.all(reads);
    expect(changes).toMatchObject([
      {
        sequence: 1,
        entity: 'crux',
        id,
        fields: ['title', 'meta'],
        metaKeys: ['secret'],
      },
      { sequence: 2, entity: 'crux', id, fields: ['meta'], metaKeys: ['next'] },
    ]);
    expect(Object.isFrozen(changes[0])).toBe(true);
    expect(Object.isFrozen(changes[0].fields)).toBe(true);
    expect(Object.isFrozen(changes[0].metaKeys)).toBe(true);
    expect(changes[0].streamId).toBe(changes[1].streamId);
    expect(JSON.stringify(changes)).not.toContain('private payload');
  });
  it('publishes nothing for rollback, invalid input or reads', async () => {
    const changes: any[] = [];
    owner.onChange((change) => {
      changes.push(change);
    });
    await owner.run(
      "CREATE TRIGGER fail_change BEFORE UPDATE ON cruxes BEGIN SELECT RAISE(ABORT, 'No commit'); END",
    );
    await expect(
      owner.updateCrux(id, { title: 'Failed' }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('No commit') },
    });
    await expect(
      owner.updateCrux(id, { authorId: 'no' } as any),
    ).rejects.toThrow();
    await owner.get('SELECT id FROM cruxes');
    expect(changes).toEqual([]);
    await owner.run('DROP TRIGGER fail_change');
    await owner.updateCrux(id, { title: 'Retry' });
    expect(changes).toMatchObject([{ sequence: 1, id }]);
  });
  it('isolates throwing/rejecting subscribers and removes unsubscribed listeners', async () => {
    owner.onChange(() => {
      throw new Error('broken consumer');
    });
    owner.onChange(async () => {
      throw new Error('broken async consumer');
    });
    const listener = jest.fn();
    const off = owner.onChange(listener);
    await owner.updateCrux(id, { title: 'Saved' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    off();
    await owner.updateCrux(id, { title: 'Still saved' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await owner.execute(({ crux }) => crux.findById(id))).title).toBe(
      'Still saved',
    );
  });
  it('captures keys before queued admission, drains delivery on close and uses a fresh stream after reopen', async () => {
    const changes: any[] = [];
    owner.onChange((change) => {
      changes.push(change);
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = owner.execute(async () => {
      await wait;
    });
    const patch: Record<string, unknown> = { before: true };
    const saved = owner.mergeCruxMeta(id, patch);
    patch.after = true;
    const closed = owner.close();
    release();
    await Promise.all([blocked, saved, closed]);
    expect(changes).toMatchObject([{ metaKeys: ['before'] }]);
    expect(() => owner.onChange(() => {})).toThrow('closing');
    const firstStream = changes[0].streamId;
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    owner.onChange((change) => {
      changes.push(change);
    });
    await owner.updateCrux(id, { title: 'Restart' });
    expect(changes[1].streamId).not.toBe(firstStream);
    expect(changes[1].sequence).toBe(1);
  });
  it('identifies the Task and its owning Crux only after a successful update', async () => {
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
          workspace: { parentId: null, messages: [], entryFile: null },
        }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const changes: any[] = [];
    owner.onChange((change) => {
      changes.push(change);
    });
    await owner.updateWorkingCopyMeta(task, { notes: 'private' }, 'Rename');
    expect(changes).toMatchObject([
      {
        entity: 'working-copy',
        id: task,
        cruxId: id,
        fields: ['meta', 'title'],
        metaKeys: ['notes'],
      },
    ]);
    await expect(
      owner.updateWorkingCopyMeta(randomUUID(), {}),
    ).rejects.toThrow();
    expect(changes).toHaveLength(1);
  });
  it('invalidates Garden membership only for successful commands', async () => {
    const garden = await owner.execute(({ crux }) =>
      crux.create({
        slug: randomUUID(),
        authorId: randomUUID(),
        homeId: randomUUID(),
        kind: 'garden' as any,
      }),
    );
    const changes: any[] = [];
    owner.onChange((change) => {
      changes.push(change);
    });
    await owner.addGardenMember({
      gardenId: garden.id,
      memberId: id,
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
    await owner.listGardenMembers(garden.id);
    await expect(
      owner.addGardenMember({
        gardenId: garden.id,
        memberId: garden.id,
        authorId: randomUUID(),
        homeId: randomUUID(),
      }),
    ).rejects.toThrow();
    await owner.removeGardenMember(garden.id, id);
    expect(changes).toMatchObject([
      { sequence: 1, entity: 'garden-membership', id: garden.id, cruxId: id },
      { sequence: 2, entity: 'garden-membership', id: garden.id, cruxId: id },
    ]);
  });
  it('signals successful database replacement, keeps subscribers and emits no reset on refusal', async () => {
    const image = await owner.exportDatabase();
    const changes: any[] = [];
    let read: Promise<any> | undefined;
    owner.onChange((change) => {
      changes.push(change);
      if (change.entity === 'database')
        read = owner.get('SELECT title FROM cruxes WHERE id = ?', [id]);
    });
    await owner.updateCrux(id, { title: 'Later' });
    await owner.replaceDatabase(image);
    expect(changes[1]).toMatchObject({ entity: 'database', sequence: 2 });
    expect((await read).title).not.toBe('Later');
    await expect(owner.replaceDatabase(new ArrayBuffer(4))).rejects.toThrow();
    expect(changes).toHaveLength(2);
    await owner.updateCrux(id, { title: 'Replaced' });
    expect(changes[2].sequence).toBe(3);
  });
});
