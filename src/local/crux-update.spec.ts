import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned Crux details update', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-details-command-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    id = (
      await owner.execute(({ crux }) =>
        crux.create({
          slug: randomUUID(),
          authorId: randomUUID(),
          homeId: randomUUID(),
          title: 'Original',
          meta: { projectFolder: '/retained', nested: { old: true } },
        }),
      )
    ).id;
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('commits mixed details and shallow metadata patches without losing independent writes across restart', async () => {
    await Promise.all([
      owner.updateCrux(id, {
        title: 'Renamed',
        meta: { ui: true, nested: { next: true } },
      }),
      owner.updateCrux(id, {
        description: 'Agent description',
        remoteId: 'remote-reference',
        meta: { agent: true },
      }),
      owner.mergeCruxMeta(id, { compatibility: true }),
    ]);
    await owner.updateCrux(id, { kind: 'snapshot' });
    expect((await owner.execute(({ crux }) => crux.findById(id))).kind).toBe(
      'snapshot',
    );
    await owner.updateCrux(id, {
      data: '',
      type: 'custom',
      kind: null,
      status: 'frozen',
      visibility: 'unlisted',
      discoverable: false,
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.execute(({ crux }) => crux.findById(id))).toMatchObject({
      title: 'Renamed',
      description: 'Agent description',
      remoteId: 'remote-reference',
      data: '',
      type: 'custom',
      kind: null,
      status: 'frozen',
      visibility: 'unlisted',
      discoverable: false,
      meta: {
        projectFolder: '/retained',
        nested: { next: true },
        ui: true,
        agent: true,
        compatibility: true,
      },
    });
  });
  it('captures mixed input at admission and drains accepted edits before closing', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = owner.execute(async () => {
      await wait;
    });
    const patch = { title: 'Before', meta: { nested: { before: true } } };
    const edit = owner.updateCrux(id, patch);
    patch.title = 'After';
    patch.meta.nested.before = false;
    const close = owner.close();
    await expect(owner.updateCrux(id, { title: 'Late' })).rejects.toThrow(
      'closing',
    );
    release();
    await Promise.all([blocker, edit, close]);
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.execute(({ crux }) => crux.findById(id))).toMatchObject({
      title: 'Before',
      meta: { nested: { before: true } },
    });
  });
  it('rolls back details, metadata and trigger effects together and permits retry', async () => {
    await owner.run("INSERT INTO settings VALUES ('preserved', 'original')");
    await owner.run(
      "CREATE TRIGGER fail_details BEFORE UPDATE ON cruxes BEGIN DELETE FROM settings; SELECT RAISE(ABORT, 'Injected failure'); END",
    );
    await expect(
      owner.updateCrux(id, { title: 'Failed', meta: { bad: true } }),
    ).rejects.toThrow('Injected failure');
    expect(await owner.get('SELECT value FROM settings')).toEqual({
      value: 'original',
    });
    expect(await owner.execute(({ crux }) => crux.findById(id))).toMatchObject({
      title: 'Original',
      meta: { projectFolder: '/retained' },
    });
    await owner.run('DROP TRIGGER fail_details');
    await owner.updateCrux(id, { title: 'Retry', meta: { good: true } });
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta,
    ).not.toHaveProperty('bad');
  });
  it('refuses slug collisions without partially applying other fields', async () => {
    const current = await owner.execute(({ crux }) => crux.findById(id));
    await owner.execute(({ crux }) =>
      crux.create({
        slug: 'occupied',
        authorId: current.authorId,
        homeId: current.homeId,
      }),
    );
    await expect(
      owner.updateCrux(id, {
        slug: 'occupied',
        title: 'Failed',
        meta: { bad: true },
      }),
    ).rejects.toThrow(/slug/i);
    expect((await owner.execute(({ crux }) => crux.findById(id))).title).toBe(
      'Original',
    );
    await owner.updateCrux(id, { slug: 'available' });
    expect((await owner.execute(({ crux }) => crux.findById(id))).slug).toBe(
      'available',
    );
  });
  it('rejects invalid or ownership-changing fields before writes and remains usable', async () => {
    for (const patch of [
      null,
      [],
      { authorId: randomUUID() },
      { deleted: new Date().toISOString() },
      { title: 1 },
      { meta: [] },
      { meta: null },
      { kind: 'unknown' },
      { status: 'unknown' },
      { visibility: 'unknown' },
      { discoverable: 1 },
      { remoteId: null },
      { meta: { bad: 1n } },
    ])
      await expect(owner.updateCrux(id, patch as any)).rejects.toThrow();
    await owner.updateCrux(id, { title: 'Valid', meta: { nullable: null } });
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.nullable,
    ).toBeNull();
  });
  it('does not create missing Cruxes or revive deleted ones', async () => {
    await expect(
      owner.updateCrux(randomUUID(), { title: 'Missing' }),
    ).rejects.toThrow('not found');
    await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);
    await expect(owner.updateCrux(id, { title: 'Revived' })).rejects.toThrow(
      'not found',
    );
    expect(
      await owner.get('SELECT title FROM cruxes WHERE id = ?', [id]),
    ).toEqual({ title: 'Original' });
  });
});
