import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned Crux metadata merge', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-meta-command-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    const crux = await owner.execute(({ crux }) =>
      crux.create({
        slug: randomUUID(),
        authorId: randomUUID(),
        homeId: randomUUID(),
        meta: { projectFolder: '/preserved', nested: { original: true } },
      }),
    );
    id = crux.id;
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('preserves independent concurrent changes and the existing shallow-merge semantics across restart', async () => {
    await Promise.all([
      owner.mergeCruxMeta(id, { first: true, nested: { replacement: true } }),
      owner.mergeCruxMeta(id, { second: 'agent', nullable: null }),
    ]);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const value = await owner.execute(({ crux }) => crux.findById(id));
    expect(value.meta).toEqual({
      projectFolder: '/preserved',
      nested: { replacement: true },
      first: true,
      second: 'agent',
      nullable: null,
    });
  });
  it('captures caller input before queued work and drains an admitted merge before close', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = owner.execute(async () => {
      await wait;
    });
    const patch = { nested: { captured: 'before' } };
    const merged = owner.mergeCruxMeta(id, patch);
    patch.nested.captured = 'after';
    const closed = owner.close();
    await expect(owner.mergeCruxMeta(id, { late: true })).rejects.toThrow(
      'closing',
    );
    release();
    await Promise.all([blocker, merged, closed]);
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.nested,
    ).toEqual({ captured: 'before' });
  });
  it('rolls back all command effects on failure and accepts a subsequent retry', async () => {
    await owner.run("INSERT INTO settings VALUES ('preserved', 'original')");
    await owner.run(
      "CREATE TRIGGER fail_meta BEFORE UPDATE ON cruxes BEGIN DELETE FROM settings; SELECT RAISE(ABORT, 'Injected failure'); END",
    );
    await expect(owner.mergeCruxMeta(id, { bad: true })).rejects.toMatchObject({
      cause: { message: expect.stringContaining('Injected failure') },
    });
    expect(await owner.get('SELECT value FROM settings')).toEqual({
      value: 'original',
    });
    await owner.run('DROP TRIGGER fail_meta');
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.bad,
    ).toBeUndefined();
    await owner.mergeCruxMeta(id, { retried: true });
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.retried,
    ).toBe(true);
  });
  it('rejects malformed input without poisoning the owner', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const patch of [
      null,
      [],
      cyclic,
      { bad: 1n },
      { toJSON: () => 'not an object' },
    ])
      await expect(owner.mergeCruxMeta(id, patch as any)).rejects.toThrow();
    await owner.mergeCruxMeta(id, { valid: true });
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.valid,
    ).toBe(true);
  });
  it('refuses missing and deleted Cruxes without resurrecting or creating them', async () => {
    await expect(
      owner.mergeCruxMeta(randomUUID(), { bad: true }),
    ).rejects.toThrow('not found');
    await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);
    await expect(owner.mergeCruxMeta(id, { bad: true })).rejects.toThrow(
      'not found',
    );
    expect(
      (await owner.get<{ meta: string }>(
        'SELECT meta FROM cruxes WHERE id = ?',
        [id],
      ))!.meta,
    ).not.toContain('bad');
  });
});
