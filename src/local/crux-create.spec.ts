import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned Crux creation', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  const input = () => ({
    slug: 'my-work',
    authorId: randomUUID(),
    homeId: randomUUID(),
    type: 'workspace',
    title: 'My work',
    meta: { notes: 'keep' },
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-create-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('serializes slug allocation across authors and Trash, with the final slug used for preparation', async () => {
    const first = await owner.createCrux(input());
    await owner.setCruxTrashed(first, true);
    const prepare = jest.fn(async (slug: string) => `/projects/${slug}`);
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => owner.createCrux(input(), prepare)),
    );
    const rows = await owner.all<{ slug: string; meta: string }>(
      'SELECT slug, meta FROM cruxes WHERE deleted IS NULL ORDER BY slug',
    );
    expect(new Set(ids).size).toBe(5);
    expect(rows.map((r) => r.slug)).toEqual([
      'my-work-2',
      'my-work-3',
      'my-work-4',
      'my-work-5',
      'my-work-6',
    ]);
    for (const row of rows)
      expect(JSON.parse(row.meta)).toEqual({
        notes: 'keep',
        projectFolder: `/projects/${row.slug}`,
      });
    expect(prepare).toHaveBeenCalledTimes(5);
  });
  it('refuses preparation failure without a visible row or notice, then retries', async () => {
    const notices: unknown[] = [];
    owner.onChange((event) => {
      notices.push(event);
    });
    await expect(
      owner.createCrux(input(), async () => {
        throw new Error('Disk full');
      }),
    ).rejects.toThrow('Disk full');
    expect(await owner.all('SELECT id FROM cruxes')).toEqual([]);
    expect(notices).toEqual([]);
    const id = await owner.createCrux(input(), async () => '/projects/ready');
    expect(notices).toMatchObject([
      { entity: 'crux-lifecycle', operation: 'create', id },
    ]);
  });
  it('rolls back late SQL failure and retains the host-prepared folder for recovery', async () => {
    const prepared: string[] = [];
    await owner.run(
      "CREATE TRIGGER refuse_create BEFORE INSERT ON cruxes BEGIN SELECT RAISE(ABORT, 'No create'); END",
    );
    await expect(
      owner.createCrux(input(), async (slug) => {
        prepared.push(slug);
        return `/projects/${slug}`;
      }),
    ).rejects.toThrow();
    expect(prepared).toEqual(['my-work']);
    expect(await owner.all('SELECT id FROM cruxes')).toEqual([]);
    await owner.run('DROP TRIGGER refuse_create');
    await owner.createCrux(input());
    expect(await owner.all('SELECT slug FROM cruxes')).toEqual([
      { slug: 'my-work' },
    ]);
  });
  it('refuses a silently ignored insert and emits no committed notice', async () => {
    await owner.run(
      'CREATE TRIGGER ignore_create BEFORE INSERT ON cruxes BEGIN SELECT RAISE(IGNORE); END',
    );
    const notices: unknown[] = [];
    owner.onChange((event) => {
      notices.push(event);
    });
    await expect(owner.createCrux(input())).rejects.toThrow();
    expect(await owner.all('SELECT id FROM cruxes')).toEqual([]);
    expect(notices).toEqual([]);
  });
  it('drains admitted folder preparation before closing and refuses later creation', async () => {
    let release!: () => void;
    let prepared!: () => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const creation = owner.createCrux(input(), async () => {
      prepared();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return '/projects/drained';
    });
    await entered;
    const closing = owner.close();
    await expect(owner.createCrux(input())).rejects.toThrow();
    release();
    const id = await creation;
    await closing;
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.get('SELECT id FROM cruxes WHERE id = ?', [id])).toEqual(
      { id },
    );
  });
  it('captures identity and nested input before queueing and survives restart', async () => {
    let release!: () => void;
    const held = owner.execute(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // Wait until the queue is held without depending on timer scheduling.
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const request = { ...input(), id: randomUUID(), kind: 'snapshot' as const };
    const originalId = request.id;
    const creation = owner.createCrux(request);
    request.id = randomUUID();
    request.slug = 'changed';
    request.meta.notes = 'changed';
    release();
    await held;
    expect(await creation).toBe(originalId);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(
      await owner.get('SELECT id, slug, kind, meta FROM cruxes WHERE id = ?', [
        originalId,
      ]),
    ).toMatchObject({
      id: originalId,
      slug: 'my-work',
      kind: 'snapshot',
      meta: JSON.stringify({ notes: 'keep' }),
    });
  });
  it('preserves supplied folders and skips folder preparation for snapshots and non-workspaces', async () => {
    const prepare = jest.fn(async () => '/unused');
    await owner.createCrux(
      { ...input(), meta: { projectFolder: '/retained' } },
      prepare,
    );
    await owner.createCrux({ ...input(), kind: 'snapshot' }, prepare);
    await owner.createCrux({ ...input(), type: 'crux' }, prepare);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('refuses duplicate identities before preparing any folder', async () => {
    const id = await owner.createCrux(input());
    await owner.setCruxTrashed(id, true);
    const prepare = jest.fn(async () => '/unused');
    await expect(owner.createCrux({ ...input(), id }, prepare)).rejects.toThrow(
      'identity',
    );
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([
    { slug: 12 },
    { authorId: '' },
    { visibility: 'public' },
    { meta: [] },
    { kind: 'invalid' },
  ])('rejects invalid inputs before preparation: %j', async (patch) => {
    const prepare = jest.fn(async () => '/unused');
    await expect(
      owner.createCrux({ ...input(), ...patch } as any, prepare),
    ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(await owner.all('SELECT id FROM cruxes')).toEqual([]);
  });
});
