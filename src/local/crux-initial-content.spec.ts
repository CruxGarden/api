import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('atomic Crux content and Garden placement', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  const objects = new Map<string, Uint8Array>();
  const store = {
    read: async (id: string) => objects.get(id) ?? null,
    write: async (id: string, bytes: Uint8Array) => {
      objects.set(id, Uint8Array.from(bytes));
    },
  };
  beforeEach(async () => {
    objects.clear();
    dir = mkdtempSync(join(tmpdir(), 'crux-initial-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = () => {
    const bytes = Buffer.from('opaque Mood package\0');
    return {
      put: {
        id: randomUUID(),
        path: 'mood.cruxmood',
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mimeType: 'application/zip',
        encoding: 'binary',
        mode: 0o644,
        attributes: {},
      },
      bytes,
    };
  };
  async function request() {
    const garden = await owner.enterLocalGarden();
    return {
      id: randomUUID(),
      slug: randomUUID(),
      title: 'Dusk',
      kind: 'mood' as const,
      authorId: randomUUID(),
      homeId: randomUUID(),
      gardenId: garden.id,
      initialFiles: [file()],
    };
  }
  const create = (input: Awaited<ReturnType<typeof request>>) =>
    owner.createCrux(input, undefined, store);

  it('commits opaque content and membership together and retains them across restart', async () => {
    const input = await request();
    const events: unknown[] = [];
    owner.onChange((event) => {
      events.push(event);
    });
    const id = await create(input);
    const head = (await owner.fileContentHead(id))!;
    expect(head.revision).toBe(1);
    expect(
      Buffer.from(
        (await owner.readFileContent(
          { cruxId: id, expected: head, path: 'mood.cruxmood' },
          store,
        ))!.bytes,
      ),
    ).toEqual(input.initialFiles[0].bytes);
    expect(
      (await owner.listGardenMembers(input.gardenId)).items.map(
        (item) => item.id,
      ),
    ).toContain(id);
    expect(await owner.all('SELECT id FROM artifacts')).toEqual([]);
    expect(events).toMatchObject([
      { entity: 'crux-lifecycle', operation: 'create', id },
    ]);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.fileContentHead(id)).toEqual(head);
    expect(
      (await owner.listGardenMembers(input.gardenId)).items.map(
        (item) => item.id,
      ),
    ).toContain(id);
  });

  it.each(['content', 'placement'])(
    'rolls back a refused %s write without a partial Crux or notice, and retries',
    async (failure) => {
      const input = await request();
      const events: unknown[] = [];
      owner.onChange((event) => {
        events.push(event);
      });
      const table = failure === 'content' ? 'file_content_heads' : 'dimensions';
      await owner.run(
        `CREATE TRIGGER refuse_initial BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'Initial save refused'); END`,
      );
      const driverFailure = {
        message: expect.stringContaining('Initial save refused'),
      };
      await expect(create(input)).rejects.toMatchObject(
        failure === 'content' ? driverFailure : { cause: driverFailure },
      );
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [input.id]),
      ).toBeUndefined();
      expect(
        await owner.get(
          'SELECT crux_id FROM file_content_heads WHERE crux_id = ?',
          [input.id],
        ),
      ).toBeUndefined();
      expect(events).toEqual([]);
      await owner.run('DROP TRIGGER refuse_initial');
      expect(await create(input)).toBe(input.id);
      expect(await owner.fileContentHead(input.id)).not.toBeNull();
    },
  );

  it('captures bytes and destination before waiting and refuses corrupt input before creating', async () => {
    const input = await request();
    const original = Buffer.from(input.initialFiles[0].bytes);
    const pending = create(input);
    input.initialFiles[0].bytes.fill(0);
    input.gardenId = randomUUID();
    input.title = 'Changed';
    const id = await pending;
    const head = (await owner.fileContentHead(id))!;
    expect(
      Buffer.from(
        (await owner.readFileContent(
          { cruxId: id, expected: head, path: 'mood.cruxmood' },
          store,
        ))!.bytes,
      ),
    ).toEqual(original);
    expect(
      await owner.get('SELECT title FROM cruxes WHERE id = ?', [id]),
    ).toEqual({ title: 'Dusk' });
    const bad = await request();
    bad.initialFiles[0].bytes.fill(0);
    await expect(create(bad)).rejects.toThrow('content');
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [bad.id]),
    ).toBeUndefined();
  });
  it('retains pending folder projection through restart, refuses an ignored head, and retries', async () => {
    const input = { ...(await request()), type: 'workspace' };
    await owner.run(
      'CREATE TRIGGER ignore_initial BEFORE INSERT ON file_content_heads BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(
      owner.createCrux(input, async () => '/projects/dusk', store),
    ).rejects.toThrow('persist');
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [input.id]),
    ).toBeUndefined();
    await owner.run('DROP TRIGGER ignore_initial');
    const id = await owner.createCrux(
      input,
      async () => '/projects/dusk',
      store,
    );
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await expect(
      owner.editFileContent(
        { cruxId: id, expected: await owner.fileContentHead(id), changes: [] },
        store,
      ),
    ).rejects.toThrow('projection');
    await expect(
      owner.finishContentProjection(id, store, async () => {
        throw new Error('Disk offline');
      }),
    ).rejects.toThrow('Disk offline');
    const apply = jest.fn(async (_folder, entries) => {
      expect(entries[0].path).toBe('mood.cruxmood');
    });
    expect(await owner.finishContentProjection(id, store, apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toBe('/projects/dusk');
    expect(await owner.finishContentProjection(id, store, apply)).toBe(false);
  });

  it('refuses missing store or failed content persistence without admitting a Crux', async () => {
    const input = await request();
    await expect(owner.createCrux(input)).rejects.toThrow('content store');
    await expect(
      owner.createCrux(input, undefined, {
        read: async () => null,
        write: async () => {
          throw new Error('Store full');
        },
      }),
    ).rejects.toThrow('Store full');
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [input.id]),
    ).toBeUndefined();
    expect(await create(input)).toBe(input.id);
  });
});
