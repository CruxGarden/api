import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { checkpointDesktopMigration } from './startup-recovery';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);

describe('pre-migration startup recovery', () => {
  let dir: string;
  let filename: string;
  let owner: LocalGraphRuntime | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crux-startup-recovery-'));
    filename = join(dir, 'working.db');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await owner?.close();
    owner = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  function seed(version = 2) {
    const db = new Database(filename);
    db.exec(schema);
    db.exec(`INSERT INTO schema_version VALUES (${version}); INSERT INTO settings VALUES ('preserved', 'before migration');
      CREATE TABLE opaque (bytes BLOB); INSERT INTO opaque VALUES (X'00FF80');`);
    if (version === 2)
      db.exec('DROP TABLE store; ALTER TABLE cruxes DROP COLUMN deleted;');
    db.close();
  }
  it('retains the complete old schema and opaque data before normalizing the working file', async () => {
    seed();
    owner = await LocalGraphRuntime.open(filename);
    const checkpoint = readdirSync(dir).find((name) =>
      name.endsWith('.pre-migration'),
    );
    expect(checkpoint).toBeDefined();
    const old = new Database(join(dir, checkpoint!), { readonly: true });
    try {
      expect(old.prepare('SELECT version FROM schema_version').get()).toEqual({
        version: 2,
      });
      expect(
        old
          .prepare("SELECT name FROM sqlite_master WHERE name = 'store'")
          .all(),
      ).toEqual([]);
      expect(
        old
          .prepare(
            "SELECT name FROM pragma_table_info('cruxes') WHERE name = 'deleted'",
          )
          .all(),
      ).toEqual([]);
      expect(old.prepare('SELECT value FROM settings').get()).toEqual({
        value: 'before migration',
      });
      expect(
        old.prepare('SELECT hex(bytes) AS bytes FROM opaque').get(),
      ).toEqual({ bytes: '00FF80' });
      expect(old.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
    } finally {
      old.close();
    }
    expect(await owner.get('SELECT version FROM schema_version')).toEqual({
      version: 4,
    });
    await owner.close();
    owner = undefined;
    const before = readdirSync(dir).filter((name) =>
      name.endsWith('.pre-migration'),
    );
    owner = await LocalGraphRuntime.open(filename);
    expect(
      readdirSync(dir).filter((name) => name.endsWith('.pre-migration')),
    ).toEqual(before);
  });
  it('captures committed WAL content without requiring the original WAL sidecar for recovery', () => {
    seed();
    const writer = new Database(filename);
    try {
      writer.pragma('journal_mode = WAL');
      writer
        .prepare("INSERT INTO settings VALUES ('wal-only', 'committed')")
        .run();
      const before = readFileSync(filename);
      const checkpoint = checkpointDesktopMigration(filename)!;
      expect(readFileSync(filename)).toEqual(before);
      const old = new Database(checkpoint, { readonly: true });
      try {
        expect(
          old
            .prepare("SELECT value FROM settings WHERE key = 'wal-only'")
            .get(),
        ).toEqual({ value: 'committed' });
      } finally {
        old.close();
      }
    } finally {
      writer.close();
    }
  });
  it('does not checkpoint a fresh or already normalized database', async () => {
    owner = await LocalGraphRuntime.create(filename);
    await owner.close();
    owner = undefined;
    expect(checkpointDesktopMigration(filename)).toBeNull();
    expect(
      readdirSync(dir).filter(
        (name) =>
          name.endsWith('.pre-migration') || name.endsWith('.checkpoint'),
      ),
    ).toEqual([]);
  });
  it('does not rewrite the schema marker or fire extension triggers on ordinary reopen', async () => {
    owner = await LocalGraphRuntime.create(filename);
    await owner.run(
      "INSERT INTO settings VALUES ('preserved', 'current schema')",
    );
    await owner.run(
      'CREATE TRIGGER opaque_version_write AFTER UPDATE ON schema_version BEGIN DELETE FROM settings; END',
    );
    await owner.close();
    owner = undefined;
    owner = await LocalGraphRuntime.open(filename);
    expect(await owner.get('SELECT value FROM settings')).toEqual({
      value: 'current schema',
    });
    expect(
      readdirSync(dir).filter((name) => name.endsWith('.pre-migration')),
    ).toEqual([]);
  });
  it('checkpoints missing additive schema even with an existing version-4 marker', async () => {
    seed(4);
    expect(checkpointDesktopMigration(filename)).not.toBeNull(); // frozen legacy DDL lacks Dimension tombstones
    owner = await LocalGraphRuntime.open(filename);
    expect(
      await owner.all(
        "SELECT name FROM pragma_table_info('dimensions') WHERE name = 'deleted'",
      ),
    ).toEqual([{ name: 'deleted' }]);
  });
  it('refuses a failed checkpoint write before changing the working database and permits retry', async () => {
    seed();
    const before = readFileSync(filename);
    const write = fs.writeFileSync;
    jest
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((file: any, bytes: any, options: any) => {
        if (String(file).endsWith('.checkpoint')) {
          write(file, Buffer.from(bytes).subarray(0, 7), options);
          throw new Error('Checkpoint disk full');
        }
        return write(file, bytes, options);
      });
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'Checkpoint disk full',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['working.db']);
    jest.restoreAllMocks();
    owner = await LocalGraphRuntime.open(filename);
    expect(await owner.get('SELECT version FROM schema_version')).toEqual({
      version: 4,
    });
  });
  it('reuses a verified checkpoint but never overwrites a corrupt checkpoint', async () => {
    seed();
    const checkpoint = checkpointDesktopMigration(filename)!;
    expect(checkpointDesktopMigration(filename)).toBe(checkpoint);
    const before = readFileSync(filename);
    writeFileSync(checkpoint, 'corrupted recovery');
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'Recovery checkpoint',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(readFileSync(checkpoint, 'utf8')).toBe('corrupted recovery');
  });
  it('retains a checkpoint before repairing a missing index at version 4', async () => {
    owner = await LocalGraphRuntime.create(filename);
    await owner.run('DROP INDEX idx_artifacts_fingerprint');
    await owner.close();
    owner = undefined;
    const checkpoint = checkpointDesktopMigration(filename)!;
    expect(checkpoint).not.toBeNull();
    owner = await LocalGraphRuntime.open(filename);
    expect(
      await owner.get(
        "SELECT name FROM sqlite_master WHERE name = 'idx_artifacts_fingerprint'",
      ),
    ).toEqual({ name: 'idx_artifacts_fingerprint' });
    const old = new Database(checkpoint, { readonly: true });
    try {
      expect(
        old
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'idx_artifacts_fingerprint'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      old.close();
    }
  });
  it('refuses a failed checkpoint publication before applying DDL and permits retry', async () => {
    seed();
    const before = readFileSync(filename);
    jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw new Error('Checkpoint publication denied');
    });
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'Checkpoint publication denied',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['working.db']);
    jest.restoreAllMocks();
    owner = await LocalGraphRuntime.open(filename);
  });
  it('does not accept a symbolic link as a retained checkpoint', async () => {
    seed();
    const checkpoint = checkpointDesktopMigration(filename)!;
    const other = join(dir, 'other-file');
    writeFileSync(other, readFileSync(checkpoint));
    fs.unlinkSync(checkpoint);
    fs.symlinkSync(other, checkpoint);
    const before = readFileSync(filename);
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'Recovery checkpoint',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(fs.lstatSync(checkpoint).isSymbolicLink()).toBe(true);
  });
  it('refuses future schemas without writing a checkpoint or changing the source', async () => {
    seed(99);
    const before = readFileSync(filename);
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'Unsupported desktop schema',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['working.db']);
  });
});
