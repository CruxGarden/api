import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import type { DesktopContentStore } from './desktop-content';
const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

describe('API-owned inline startup migration', () => {
  let dir: string;
  let filename: string;
  let owner: LocalGraphRuntime | undefined;
  let content: Map<string, Uint8Array>;
  let store: DesktopContentStore;
  const payloads = [
    Buffer.from('Dream 🌱'),
    Buffer.from([0, 255, 128]),
    Buffer.alloc(0),
  ];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crux-startup-content-'));
    filename = join(dir, 'garden.db');
    content = new Map();
    store = {
      read: async (fp) => content.get(fp) ?? null,
      write: async (fp, bytes) => {
        content.set(fp, Uint8Array.from(bytes));
      },
    };
    const db = new Database(filename);
    db.exec(schema);
    db.exec(`INSERT INTO schema_version VALUES (1);
      ALTER TABLE artifacts ADD COLUMN content BLOB;
      INSERT INTO settings VALUES ('preserved', 'original');
      CREATE TABLE opaque (value BLOB); INSERT INTO opaque VALUES (X'00FF80');`);
    payloads.forEach((bytes, i) =>
      db
        .prepare(
          `INSERT INTO artifacts
      (id, resource_id, author_id, home_id, content, created, updated)
      VALUES (?, ?, 'author', 'home', ?, 'before', 'before')`,
        )
        .run(
          `file-${i}`,
          i ? 'history' : 'main',
          i === 0 ? bytes.toString() : bytes,
        ),
    );
    db.close();
  });
  afterEach(async () => {
    await owner?.close();
    owner = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  it('externalizes inline files during owned startup and retains the original checkpoint across reopen', async () => {
    owner = await LocalGraphRuntime.open(filename, { contentStore: store });
    expect(
      await owner.all('SELECT fingerprint, updated FROM artifacts ORDER BY id'),
    ).toEqual(
      payloads.map((bytes) => ({
        fingerprint: hash(bytes),
        updated: 'before',
      })),
    );
    for (const bytes of payloads)
      expect(Buffer.from(content.get(hash(bytes))!)).toEqual(bytes);
    expect(await owner.get('SELECT version FROM schema_version')).toEqual({
      version: 4,
    });
    expect(await owner.get('SELECT hex(value) AS value FROM opaque')).toEqual({
      value: '00FF80',
    });
    const checkpoints = readdirSync(dir).filter((name) =>
      name.endsWith('.pre-migration'),
    );
    expect(checkpoints).toHaveLength(1);
    const old = new Database(join(dir, checkpoints[0]), { readonly: true });
    try {
      expect(old.prepare('SELECT version FROM schema_version').get()).toEqual({
        version: 1,
      });
      expect(
        old
          .prepare('SELECT content FROM artifacts ORDER BY id')
          .all()
          .map((row: any) => Buffer.from(row.content)),
      ).toEqual(payloads);
    } finally {
      old.close();
    }
    await owner.close();
    owner = await LocalGraphRuntime.open(filename);
    expect(await owner.get('SELECT value FROM settings')).toEqual({
      value: 'original',
    });
    expect(
      readdirSync(dir).filter((name) => name.endsWith('.pre-migration')),
    ).toEqual(checkpoints);
  });
  function oldState() {
    const db = new Database(filename, { readonly: true });
    try {
      return {
        version: db.prepare('SELECT version FROM schema_version').get(),
        files: db
          .prepare('SELECT content, fingerprint FROM artifacts ORDER BY id')
          .all(),
      };
    } finally {
      db.close();
    }
  }
  it.each(['write', 'read-back', 'schema'])(
    'retains inline data and allows retry after a %s failure',
    async (fault) => {
      const before = oldState();
      const write = store.write;
      if (fault !== 'schema')
        store.write = async (fp, bytes) => {
          if (fp === hash(payloads[1])) {
            if (fault === 'write') throw new Error('Injected disk full');
            content.set(fp, Buffer.from('short'));
          } else await write(fp, bytes);
        };
      const exec = Database.prototype.exec;
      if (fault === 'schema')
        Database.prototype.exec = function (sql: string) {
          if (sql === 'UPDATE schema_version SET version = 4')
            throw new Error('Injected DDL failure');
          return exec.call(this, sql);
        };
      try {
        await expect(
          LocalGraphRuntime.open(filename, { contentStore: store }),
        ).rejects.toThrow();
      } finally {
        Database.prototype.exec = exec;
      }
      expect(oldState()).toEqual(before);
      expect(content.has(hash(payloads[0]))).toBe(true);
      store.write = write;
      if (fault === 'read-back') content.delete(hash(payloads[1]));
      owner = await LocalGraphRuntime.open(filename, { contentStore: store });
      expect(
        await owner.get('SELECT COUNT(*) AS count FROM artifacts'),
      ).toEqual({ count: 3 });
    },
  );
  it('reserves ownership throughout asynchronous content verification', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const read = store.read;
    store.read = async (fp) => {
      entered();
      await wait;
      return read(fp);
    };
    const opening = LocalGraphRuntime.open(filename, { contentStore: store });
    await ready;
    try {
      await expect(
        LocalGraphRuntime.open(filename, { contentStore: store }),
      ).rejects.toThrow('already owned');
    } finally {
      release();
    }
    owner = await opening;
    expect(await owner.get('SELECT value FROM settings')).toEqual({
      value: 'original',
    });
  });
  it('refuses inline startup without an explicit content store', async () => {
    const before = readFileSync(filename);
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'Inline artifact',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(
      readdirSync(dir).filter((name) => name.endsWith('.pre-migration')),
    ).toEqual([]);
  });
  it('rolls back conversion when retained external content is unavailable', async () => {
    const missing = hash(Buffer.from('missing history'));
    const db = new Database(filename);
    db.prepare(
      "UPDATE artifacts SET content = NULL, fingerprint = ? WHERE id = 'file-2'",
    ).run(missing);
    db.close();
    const before = oldState();
    await expect(
      LocalGraphRuntime.open(filename, { contentStore: store }),
    ).rejects.toThrow('Missing recovery content');
    expect(oldState()).toEqual(before);
    content.set(missing, Buffer.from('missing history'));
    owner = await LocalGraphRuntime.open(filename, { contentStore: store });
    expect(
      await owner.get("SELECT fingerprint FROM artifacts WHERE id = 'file-2'"),
    ).toEqual({ fingerprint: missing });
  });
  it('does not update an already-current schema marker when extracting inline content', async () => {
    // First obtain the API-normalized DDL using a separate fresh database.
    const normalized = await LocalGraphRuntime.create(
      join(dir, 'normalized.db'),
    );
    await normalized.run('ALTER TABLE artifacts ADD COLUMN content BLOB');
    await normalized.run(
      "INSERT INTO artifacts (id, resource_id, author_id, home_id, content, created, updated) VALUES ('file', 'main', 'author', 'home', 'hello', 'before', 'before')",
    );
    await normalized.run(
      "INSERT INTO settings VALUES ('preserved', 'original')",
    );
    await normalized.run(
      'CREATE TRIGGER preserve_marker AFTER UPDATE ON schema_version BEGIN DELETE FROM settings; END',
    );
    await normalized.close();
    owner = await LocalGraphRuntime.open(join(dir, 'normalized.db'), {
      contentStore: store,
    });
    expect(await owner.get('SELECT value FROM settings')).toEqual({
      value: 'original',
    });
  });
});
