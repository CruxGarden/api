import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync, readdirSync, realpathSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';
import {
  inspectDesktopManifestRecovery,
  openDesktopRecovery,
} from './desktop-recovery';
import * as migration from './desktop-migration';

describe('manifest-aware API installation replacement', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let objects: Map<string, Uint8Array>;
  let store: DesktopContentStore;
  let incoming: ArrayBuffer;
  let current: Awaited<ReturnType<typeof seed>>;
  let replacement: Awaited<ReturnType<typeof seed>>;
  function file(text: string) {
    const bytes = Buffer.from(text);
    return {
      put: {
        id: 'file',
        path: 'document.txt',
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mimeType: 'text/plain',
        encoding: 'utf-8',
        mode: 0o644,
        attributes: {},
      },
      bytes,
    };
  }
  async function seed(runtime: LocalGraphRuntime, name: string) {
    const id = await runtime.createCrux({
      slug: randomUUID(),
      title: name,
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
    const head = await runtime.editFileContent(
      { cruxId: id, expected: null, changes: [file(name)] },
      store,
    );
    const snapshot = await runtime.createGrowthSnapshot(
      {
        cruxId: id,
        expected: head,
        snapshotId: randomUUID(),
        parentId: null,
        meta: { messages: [{ content: name }] },
      },
      store,
    );
    const latest = await runtime.editFileContent(
      { cruxId: id, expected: head, changes: [file(`${name} edited`)] },
      store,
    );
    return { id, head: latest, snapshot, name };
  }
  async function text(runtime: LocalGraphRuntime, data: typeof current) {
    const result = await runtime.readFileContent(
      {
        cruxId: data.snapshot.snapshot.id,
        expected: data.snapshot.head,
        path: 'document.txt',
      },
      store,
    );
    return Buffer.from(result!.bytes).toString();
  }
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'manifest-replace-')));
    objects = new Map();
    store = {
      read: async (fp) => objects.get(fp) ?? null,
      write: async (fp, bytes) => {
        objects.set(fp, Uint8Array.from(bytes));
      },
    };
    owner = await LocalGraphRuntime.create(join(dir, 'current.db'));
    current = await seed(owner, 'Current');
    const source = await LocalGraphRuntime.create(join(dir, 'incoming.db'));
    try {
      replacement = await seed(source, 'Incoming');
      await source.run('CREATE TABLE extension_data (value TEXT)');
      await source.run("INSERT INTO extension_data VALUES ('preserve')");
      incoming = await source.exportDatabase();
    } finally {
      await source.close();
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces and reopens the whole graph with readable history, opaque records and a complete rollback image', async () => {
    const count = objects.size;
    const previous = await owner.replaceDatabaseWithContent(incoming, store);
    expect(await text(owner, replacement)).toBe('Incoming');
    expect(await owner.all('SELECT * FROM extension_data')).toEqual([
      { value: 'preserve' },
    ]);
    await inspectDesktopManifestRecovery(previous, store);
    expect(objects.size).toBe(count);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'current.db'));
    expect(await text(owner, replacement)).toBe('Incoming');
    await owner.replaceDatabaseWithContent(previous, store);
    expect(await text(owner, current)).toBe('Current');
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
  });

  it.each(['Incoming', 'Current'])(
    'refuses missing %s historical bytes before swapping the working database and supports retry',
    async (name) => {
      const fingerprint = file(name).put.fingerprint;
      const bytes = objects.get(fingerprint)!;
      objects.delete(fingerprint);
      const notices = jest.fn();
      owner.onChange(notices);
      await expect(
        owner.replaceDatabaseWithContent(incoming, store),
      ).rejects.toThrow();
      expect(await owner.fileContentHead(current.id)).toEqual(current.head);
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [replacement.id]),
      ).toBeUndefined();
      expect(notices).not.toHaveBeenCalled();
      expect(
        readdirSync(dir).some(
          (name) => name.endsWith('.restore') || name.endsWith('.recovery'),
        ),
      ).toBe(false);
      objects.set(fingerprint, bytes);
      await owner.replaceDatabaseWithContent(incoming, store);
      expect(await text(owner, replacement)).toBe('Incoming');
      expect(notices).toHaveBeenCalledTimes(1);
    },
  );

  it('captures queued image/reader, drains admitted writes and refuses new work during asynchronous verification', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const earlier = owner.execute(async () => {
      await wait;
    });
    const admitted = owner.run(
      "INSERT INTO settings VALUES ('last-write', 'retained')",
    );
    const pending = owner.replaceDatabaseWithContent(incoming, store);
    new Uint8Array(incoming).fill(0);
    const originalRead = store.read;
    store.read = async () => {
      throw new Error('Reader changed');
    };
    try {
      await expect(owner.run('DELETE FROM settings')).rejects.toThrow(
        'replacing',
      );
      await expect(
        owner.replaceDatabaseWithContent(new ArrayBuffer(0), store),
      ).rejects.toThrow('replacing');
      await expect(
        LocalGraphRuntime.open(join(dir, 'current.db')),
      ).rejects.toThrow('already owned');
    } finally {
      release();
    }
    await Promise.all([earlier, admitted]);
    const previous = await pending;
    store.read = originalRead;
    await owner.replaceDatabaseWithContent(previous, store);
    expect(
      await owner.get("SELECT value FROM settings WHERE key = 'last-write'"),
    ).toEqual({ value: 'retained' });
    expect(await text(owner, current)).toBe('Current');
  });

  it('restores the previous manifest graph after the replacement file cannot be renamed', async () => {
    const rename = fs.renameSync;
    const fail = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.restore')) throw new Error('Swap refused');
      return rename(from, to);
    });
    await expect(
      owner.replaceDatabaseWithContent(incoming, store),
    ).rejects.toThrow('Swap refused');
    fail.mockRestore();
    expect(await text(owner, current)).toBe('Current');
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'current.db'));
    await owner.replaceDatabaseWithContent(incoming, store);
    expect(await text(owner, replacement)).toBe('Incoming');
  });

  it('rolls back readable manifest history when reopening the swapped database fails', async () => {
    const original = migration.migrateDesktopDatabase;
    let failed = false;
    jest
      .spyOn(migration, 'migrateDesktopDatabase')
      .mockImplementation(async (db, content) => {
        if (
          !failed &&
          db.client.config.connection.filename === join(dir, 'current.db')
        ) {
          failed = true;
          throw new Error('Reopen refused');
        }
        return original(db, content);
      });
    await expect(
      owner.replaceDatabaseWithContent(incoming, store),
    ).rejects.toThrow('Reopen refused');
    expect(failed).toBe(true);
    expect(await text(owner, current)).toBe('Current');
    expect(
      await owner.get('SELECT id FROM cruxes WHERE id = ?', [replacement.id]),
    ).toBeUndefined();
    await owner.replaceDatabaseWithContent(incoming, store);
    expect(await text(owner, replacement)).toBe('Incoming');
  });

  it('requires the current format and does not convert older images', async () => {
    const image = openDesktopRecovery(incoming, true);
    let older: ArrayBuffer;
    try {
      image.exec(
        'ALTER TABLE working_copies RENAME COLUMN base_state TO base_snapshot_id; UPDATE schema_version SET version = 4',
      );
      older = Uint8Array.from(image.serialize()).buffer;
    } finally {
      image.close();
    }
    await expect(
      owner.replaceDatabaseWithContent(older, store),
    ).rejects.toThrow('current-format');
    expect(await text(owner, current)).toBe('Current');
  });

  it('rejects invalid images without poisoning the current owner', async () => {
    await expect(
      owner.replaceDatabaseWithContent(new ArrayBuffer(20), store),
    ).rejects.toThrow();
    expect(await text(owner, current)).toBe('Current');
    await owner.replaceDatabaseWithContent(incoming, store);
    expect(await text(owner, replacement)).toBe('Incoming');
  });
});
