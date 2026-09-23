import { randomUUID } from 'crypto';
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { inspectDesktopRecovery } from './desktop-recovery';
import { CruxKind } from '../common/types/enums';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);
const authorId = '82a31c44-1e81-4a4f-aa88-7c3e941c1565';
const homeId = 'ebd5394c-74cd-4a77-a2bb-61f448ba850e';
const input = () => ({
  slug: randomUUID(),
  authorId,
  homeId,
  kind: CruxKind.GARDEN,
  meta: { displayName: 'Studio' },
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('single-owner local API runtime', () => {
  let scratch: string;
  let filename: string;
  let runtime: LocalGraphRuntime;

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crux-api-owner-'));
    filename = join(scratch, 'cruxgarden.db');
    const db = new Database(filename);
    db.exec(schema);
    db.close();
    runtime = await LocalGraphRuntime.open(filename);
  });

  afterEach(async () => {
    await runtime?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('bootstraps a fresh API-owned file, uses graph commands and reopens its recovery image', async () => {
    const freshPath = join(scratch, 'fresh.db');
    let fresh = await LocalGraphRuntime.create(freshPath);
    try {
      const garden = await fresh.execute(({ crux }) => crux.create(input()));
      const child = await fresh.execute(({ crux }) => crux.create(input()));
      await fresh.addGardenMember({
        gardenId: garden.id,
        memberId: child.id,
        authorId,
        homeId,
      });
      await fresh.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
        'fixture',
        'preserved',
      ]);
      const image = await fresh.closeWithRecoveryImage();
      expect(inspectDesktopRecovery(image).schemaVersion).toBe(4);
      const recoveredPath = join(scratch, 'fresh-recovered.db');
      writeFileSync(recoveredPath, Buffer.from(image));
      fresh = await LocalGraphRuntime.open(recoveredPath);
      expect(
        (await fresh.listGardenMembers(garden.id)).items.map((item) => item.id),
      ).toEqual([child.id]);
      expect(
        await fresh.get('SELECT value FROM settings WHERE key = ?', [
          'fixture',
        ]),
      ).toEqual({ value: 'preserved' });
      expect(
        await fresh.all(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'subscriptions', 'billing_simulation')",
        ),
      ).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it('never overwrites existing bytes and admits only one concurrent fresh creator', async () => {
    const untouched = join(scratch, 'not-a-database.db');
    const bytes = Buffer.from('existing content');
    writeFileSync(untouched, bytes);
    await expect(LocalGraphRuntime.create(untouched)).rejects.toThrow();
    expect(readFileSync(untouched)).toEqual(bytes);
    const freshPath = join(scratch, 'concurrent.db');
    const results = await Promise.allSettled([
      LocalGraphRuntime.create(freshPath),
      LocalGraphRuntime.create(freshPath),
    ]);
    const owners = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    try {
      expect(owners).toHaveLength(1);
      await expect(LocalGraphRuntime.open(freshPath)).rejects.toThrow(
        'already owned',
      );
      const crux = await owners[0].execute(({ crux }) => crux.create(input()));
      expect(
        (await owners[0].execute(({ crux: graph }) => graph.findById(crux.id)))
          .id,
      ).toBe(crux.id);
    } finally {
      await Promise.all(owners.map((owner) => owner.close()));
    }
    const saved = readFileSync(freshPath);
    await expect(LocalGraphRuntime.create(freshPath)).rejects.toThrow();
    expect(readFileSync(freshPath)).toEqual(saved);
  });

  it('rolls back failed bootstrap DDL and releases ownership without deleting the file', async () => {
    const failedPath = join(scratch, 'failed-bootstrap.db');
    const original = Database.prototype.exec;
    const fail = jest
      .spyOn(Database.prototype, 'exec')
      .mockImplementation(function (this: unknown, sql: unknown) {
        const result = original.call(this, sql);
        if (
          typeof sql === 'string' &&
          sql.includes('INSERT INTO schema_version (version) VALUES (4)')
        )
          throw new Error('bootstrap interrupted');
        return result;
      });
    try {
      await expect(LocalGraphRuntime.create(failedPath)).rejects.toThrow(
        'bootstrap interrupted',
      );
    } finally {
      fail.mockRestore();
    }
    const inspect = new Database(failedPath, { fileMustExist: true });
    try {
      expect(
        inspect
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all(),
      ).toEqual([]);
      // The failed file stays available for diagnosis; explicit repair can reopen it.
      inspect.exec(schema);
    } finally {
      inspect.close();
    }
    const repaired = await LocalGraphRuntime.open(failedPath);
    await repaired.close();
  });

  it('shares graph and legacy operations while preserving their distinct row contracts', async () => {
    const crux = await runtime.execute(({ crux }) => crux.create(input()));
    const legacy = await runtime.get<{
      meta: string;
      discoverable: number;
      created: string;
    }>('SELECT * FROM cruxes WHERE id = ?', [crux.id]);
    expect(legacy.meta).toBe(JSON.stringify(crux.meta));
    expect(legacy.discoverable).toBe(0);
    expect(typeof legacy.created).toBe('string');
    expect(
      await runtime.run('UPDATE cruxes SET meta = ? WHERE id = ?', [
        { displayName: 'Library' },
        crux.id,
      ]),
    ).toEqual({ changes: 1 });
    expect(
      await runtime.execute(({ crux: graph }) => graph.findById(crux.id)),
    ).toMatchObject({ meta: { displayName: 'Library' } });
    const databases = await runtime.all('PRAGMA database_list');
    expect(databases).toHaveLength(1);
    expect(databases[0].name).toBe('main');
  });

  it.each(['same path', 'symlink', 'hard link'])(
    'refuses a second runtime for the same database through %s',
    async (alias) => {
      const target =
        alias === 'same path' ? filename : join(scratch, 'alias.db');
      if (alias === 'symlink') symlinkSync(filename, target);
      if (alias === 'hard link') linkSync(filename, target);
      let duplicate: LocalGraphRuntime | undefined;
      try {
        await expect(
          LocalGraphRuntime.open(target).then((opened) => {
            duplicate = opened;
          }),
        ).rejects.toThrow('already owned');
        const created = await runtime.execute(({ crux }) =>
          crux.create(input()),
        );
        expect(
          await runtime.get('SELECT id FROM cruxes WHERE id = ?', [created.id]),
        ).toEqual({ id: created.id });
      } finally {
        await duplicate?.close();
      }
    },
  );

  it('admits exactly one of two simultaneous opens and releases ownership after close', async () => {
    await runtime.close();
    const results = await Promise.allSettled([
      LocalGraphRuntime.open(filename),
      LocalGraphRuntime.open(filename),
    ]);
    const opened = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    try {
      expect(opened).toHaveLength(1);
      const refused = results.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(refused.reason.message).toContain('already owned');
    } finally {
      await Promise.all(opened.map((owner) => owner.close()));
    }
    runtime = await LocalGraphRuntime.open(filename);
    expect(await runtime.all('SELECT * FROM cruxes')).toEqual([]);
  });

  it('allows independent database owners without sharing their queues or data', async () => {
    const otherFile = join(scratch, 'independent.db');
    const seed = new Database(otherFile);
    seed.exec(schema);
    seed.close();
    const other = await LocalGraphRuntime.open(otherFile);
    try {
      const created = await other.execute(({ crux }) => crux.create(input()));
      expect(await other.get('SELECT id FROM cruxes')).toEqual({
        id: created.id,
      });
      expect(await runtime.all('SELECT * FROM cruxes')).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('keeps ownership while shutdown drains a command', async () => {
    const entered = signal();
    const release = signal();
    const work = runtime.execute(async ({ crux }) => {
      entered.resolve();
      await release.promise;
      return crux.create(input());
    });
    await entered.promise;
    const closing = runtime.close();
    let duplicate: LocalGraphRuntime | undefined;
    try {
      await expect(
        LocalGraphRuntime.open(filename).then((opened) => {
          duplicate = opened;
        }),
      ).rejects.toThrow('already owned');
    } finally {
      release.resolve();
      await duplicate?.close();
      await closing;
    }
    const created = await work;
    runtime = await LocalGraphRuntime.open(filename);
    expect(
      await runtime.execute(({ crux }) => crux.findById(created.id)),
    ).toMatchObject({ id: created.id });
  });

  it('captures a recovery image after admitted writes drain and refuses later work', async () => {
    const entered = signal();
    const release = signal();
    const write = runtime.execute(async ({ crux }) => {
      entered.resolve();
      await release.promise;
      return crux.create(input());
    });
    await entered.promise;
    const recovery = runtime.closeWithRecoveryImage();
    expect(runtime.closeWithRecoveryImage()).toBe(recovery);
    try {
      await expect(
        runtime.run(
          "INSERT INTO settings VALUES ('too-late', 'wrong database')",
        ),
      ).rejects.toThrow('closing');
      await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
        'already owned',
      );
    } finally {
      release.resolve();
    }
    const created = await write;
    const bytes = await recovery;
    const snapshot = new Database(
      Buffer.from(inspectDesktopRecovery(bytes).database),
    );
    try {
      expect(
        snapshot.prepare('SELECT id FROM cruxes WHERE id = ?').get(created.id),
      ).toEqual({ id: created.id });
      expect(
        snapshot.prepare("SELECT * FROM settings WHERE key = 'too-late'").get(),
      ).toBeUndefined();
    } finally {
      snapshot.close();
    }
    runtime = await LocalGraphRuntime.open(filename);
    expect(
      await runtime.execute(({ crux }) => crux.findById(created.id)),
    ).toMatchObject({ id: created.id });
  });

  it('finishes closing before reporting a failed recovery export, leaving records reopenable', async () => {
    const created = await runtime.execute(({ crux }) => crux.create(input()));
    const serialize = jest
      .spyOn(Database.prototype, 'serialize')
      .mockImplementation(() => {
        throw new Error('Recovery image unavailable');
      });
    try {
      await expect(runtime.closeWithRecoveryImage()).rejects.toThrow(
        'Recovery image unavailable',
      );
    } finally {
      serialize.mockRestore();
    }
    runtime = await LocalGraphRuntime.open(filename);
    expect(
      await runtime.execute(({ crux }) => crux.findById(created.id)),
    ).toMatchObject({ id: created.id });
  });

  it('refuses recovery close within a transaction without poisoning the owner', async () => {
    await expect(
      runtime.execute(() => runtime.closeWithRecoveryImage()),
    ).rejects.toThrow('within a command');
    const created = await runtime.execute(({ crux }) => crux.create(input()));
    const image = await runtime.closeWithRecoveryImage();
    expect(inspectDesktopRecovery(image).schemaVersion).toBe(0);
    runtime = await LocalGraphRuntime.open(filename);
    expect(
      await runtime.execute(({ crux }) => crux.findById(created.id)),
    ).toMatchObject({ id: created.id });
  });

  it('refuses a recovery request after ordinary shutdown starts', async () => {
    const closing = runtime.close();
    await expect(runtime.closeWithRecoveryImage()).rejects.toThrow('closing');
    await closing;
  });

  it('rolls back a whole graph command across real repositories, then accepts the next command', async () => {
    const root = await runtime.execute(({ crux }) => crux.create(input()));
    const child = input();
    await expect(
      runtime.execute(async ({ crux }) => {
        const created = await crux.create(child);
        await crux.createDimension(root.id, {
          targetId: created.id,
          type: 'garden',
          kind: 'membership',
          authorId,
          homeId,
        });
        throw new Error('interrupted operation');
      }),
    ).rejects.toThrow('interrupted operation');
    expect(
      await runtime.get('SELECT * FROM cruxes WHERE slug = ?', [child.slug]),
    ).toBeUndefined();
    expect(await runtime.all('SELECT * FROM dimensions')).toEqual([]);
    const next = await runtime.execute(({ crux }) => crux.create(input()));
    expect(next.id).toBeTruthy();
  });

  it('keeps a queued legacy read outside a running graph transaction', async () => {
    const entered = signal();
    const release = signal();
    const create = runtime.execute(async ({ crux }) => {
      const created = await crux.create(input());
      entered.resolve();
      await release.promise;
      return created;
    });
    await entered.promise;
    let readFinished = false;
    const read = runtime.all('SELECT * FROM cruxes').then((rows) => {
      readFinished = true;
      return rows;
    });
    try {
      await new Promise<void>((r) => setImmediate(r));
      expect(readFinished).toBe(false);
    } finally {
      release.resolve();
    }
    const created = await create;
    expect(await read).toEqual([expect.objectContaining({ id: created.id })]);
  });

  it('captures legacy targets and values when queued, before caller state changes', async () => {
    const original = await runtime.execute(({ crux }) => crux.create(input()));
    const other = await runtime.execute(({ crux }) => crux.create(input()));
    const entered = signal();
    const release = signal();
    const blocking = runtime.execute(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const meta = { nested: { title: 'Captured' } };
    const writeArgs: unknown[] = [meta, original.id];
    const readArgs = [original.id];
    const bytes = Buffer.from([1, 2, 3]);
    const write = runtime.run(
      'UPDATE cruxes SET meta = ? WHERE id = ?',
      writeArgs,
    );
    const read = runtime.get(
      'SELECT id, meta FROM cruxes WHERE id = ?',
      readArgs,
    );
    const rows = runtime.all('SELECT id FROM cruxes WHERE id = ?', readArgs);
    const binary = runtime.get('SELECT hex(?) AS value', [bytes]);
    meta.nested.title = 'Changed';
    writeArgs[1] = other.id;
    readArgs[0] = other.id;
    bytes.fill(9);
    release.resolve();
    await blocking;
    await expect(write).resolves.toEqual({ changes: 1 });
    await expect(read).resolves.toEqual({
      id: original.id,
      meta: JSON.stringify({ nested: { title: 'Captured' } }),
    });
    await expect(rows).resolves.toEqual([{ id: original.id }]);
    await expect(binary).resolves.toEqual({ value: '010203' });
    expect(
      await runtime.execute(({ crux }) => crux.findById(other.id)),
    ).toMatchObject({
      meta: { displayName: 'Studio' },
    });
  });

  it('rejects an unserializable binding as a promise without poisoning later work', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(runtime.run('SELECT ?', [cyclic])).rejects.toThrow();
    await expect(runtime.get('SELECT ? AS value', [true])).resolves.toEqual({
      value: 1,
    });
  });

  it('rejects reentrant commands and shutdown instead of deadlocking the owner', async () => {
    await runtime.execute(async () => {
      await expect(runtime.all('SELECT * FROM cruxes')).rejects.toThrow(
        'Nested',
      );
      await expect(
        runtime.execute(({ crux }) => crux.create(input())),
      ).rejects.toThrow('Nested');
      await expect(runtime.close()).rejects.toThrow('within a command');
    });
    expect(await runtime.all('SELECT * FROM cruxes')).toEqual([]);
  });

  it('exports the owned connection after pending writes and preserves data across restart', async () => {
    const created = runtime.execute(({ crux }) => crux.create(input()));
    const image = await runtime.exportDatabase();
    const result = await created;
    // Installation restore writes an image to disk. A WAL image cannot be
    // opened as an in-memory SQLite database by deserialize().
    const exported = join(scratch, 'exported.db');
    writeFileSync(exported, Buffer.from(image));
    const snapshot = new Database(exported);
    try {
      expect(snapshot.prepare('SELECT id FROM cruxes').all()).toEqual([
        { id: result.id },
      ]);
    } finally {
      snapshot.close();
    }
    await runtime.close();
    runtime = await LocalGraphRuntime.open(filename);
    expect(
      await runtime.execute(({ crux }) => crux.findById(result.id)),
    ).toMatchObject({ id: result.id });
  });

  it('drains admitted work on close and refuses new operations', async () => {
    const entered = signal();
    const release = signal();
    const work = runtime.execute(async ({ crux }) => {
      entered.resolve();
      await release.promise;
      return crux.create(input());
    });
    await entered.promise;
    const close = runtime.close();
    const refused = expect(runtime.all('SELECT * FROM cruxes')).rejects.toThrow(
      'closing',
    );
    release.resolve();
    await refused;
    const created = await work;
    await close;
    expect(runtime.close()).toBe(close);
    runtime = await LocalGraphRuntime.open(filename);
    expect(
      await runtime.execute(({ crux }) => crux.findById(created.id)),
    ).toMatchObject({ id: created.id });
  });

  it.each([
    'BEGIN',
    '-- comment\nBEGIN TRANSACTION',
    '/* comment */ ATTACH DATABASE ? AS other',
    'END',
  ])('refuses cross-command connection control: %s', async (sql) => {
    await expect(runtime.run(sql)).rejects.toThrow('owned API transaction');
    expect(await runtime.all('PRAGMA database_list')).toHaveLength(1);
  });

  it('closes a failed startup and permits a subsequent valid startup', async () => {
    const broken = join(scratch, 'incomplete.db');
    const db = new Database(broken);
    db.exec('CREATE TABLE unrelated (id TEXT)');
    db.close();
    await expect(LocalGraphRuntime.open(broken)).rejects.toThrow(
      'missing cruxes',
    );
    const repair = new Database(broken);
    repair.exec(schema);
    repair.close();
    const recovered = await LocalGraphRuntime.open(broken);
    await recovered.close();
  });

  it('refuses a corrupt database without retaining a connection pool', async () => {
    const broken = join(scratch, 'corrupt.db');
    writeFileSync(broken, 'not a sqlite database');
    const close = jest.spyOn(Database.prototype, 'close');
    try {
      // The native addon can retain an Error constructor from another Jest
      // realm when suites share a worker. Assert SQLite's actual failure code.
      await expect(LocalGraphRuntime.open(broken)).rejects.toMatchObject({
        code: 'SQLITE_NOTADB',
      });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
