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
      await expect(LocalGraphRuntime.open(broken)).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
