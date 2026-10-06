import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { inspectDesktopRecovery } from './desktop-recovery';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);

describe('desktop API schema admission and migration', () => {
  let scratch: string;
  let filename: string;
  let owner: LocalGraphRuntime | undefined;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'crux-api-migration-'));
    filename = join(scratch, 'legacy.db');
    owner = undefined;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await owner?.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  function seed(sql: string, definition = schema) {
    const db = new Database(filename);
    try {
      db.exec(definition);
      db.exec(sql);
    } finally {
      db.close();
    }
  }
  async function open() {
    owner = await LocalGraphRuntime.open(filename);
    return owner;
  }

  it('refuses a newer schema before changing the file or journal mode', async () => {
    seed(
      "INSERT INTO schema_version VALUES (99); INSERT INTO settings VALUES ('preserved', 'future');",
    );
    const before = readFileSync(filename);
    await expect(open()).rejects.toThrow('Unsupported desktop schema version');
    expect(readFileSync(filename)).toEqual(before);
  });
  it('refuses missing required columns before adding any schema state', async () => {
    seed('ALTER TABLE cruxes DROP COLUMN data');
    const before = readFileSync(filename);
    await expect(open()).rejects.toThrow('missing cruxes.data');
    expect(readFileSync(filename)).toEqual(before);
  });
  it.each([null, 0, 1, 2, 3, 4])(
    'normalizes external-content schema %s idempotently',
    async (version) => {
      seed(`${version === null ? '' : `INSERT INTO schema_version VALUES (${version});`}
      INSERT INTO settings VALUES ('preserved', 'legacy');
      ${(version ?? 0) < 3 ? 'DROP TABLE store;' : ''}
      DROP TABLE working_copies; DROP TABLE task_merges;
      ${(version ?? 0) < 4 ? 'ALTER TABLE cruxes DROP COLUMN deleted;' : ''}
      CREATE TABLE extension_payload (bytes BLOB);
      INSERT INTO extension_payload VALUES (X'00FF0780');`);
      await open();
      expect(await owner.get('SELECT version FROM schema_version')).toEqual({
        version: 4,
      });
      expect(
        await owner.get("SELECT value FROM settings WHERE key = 'preserved'"),
      ).toEqual({ value: 'legacy' });
      expect(
        await owner.get('SELECT hex(bytes) AS bytes FROM extension_payload'),
      ).toEqual({ bytes: '00FF0780' });
      await owner.run(
        "INSERT INTO cruxes (id, author_id, home_id, deleted, created, updated) VALUES ('crux', 'author', 'home', NULL, 'now', 'now')",
      );
      expect(await owner.all('SELECT * FROM store')).toEqual([]);
      expect(await owner.all('SELECT * FROM working_copies')).toEqual([]);
      expect(await owner.all('SELECT * FROM task_merges')).toEqual([]);
      await owner.close();
      await open();
      expect(await owner.all('SELECT id FROM cruxes')).toEqual([
        { id: 'crux' },
      ]);
      expect(await owner.all('SELECT version FROM schema_version')).toEqual([
        { version: 4 },
      ]);
    },
  );

  it('refuses inline content until a verified blob conversion can preserve it', async () => {
    seed(`INSERT INTO schema_version VALUES (1);
      ALTER TABLE artifacts ADD COLUMN content BLOB;
      INSERT INTO artifacts (id, resource_id, author_id, home_id, content, created, updated)
      VALUES ('file', 'crux', 'author', 'home', X'00FF0780', 'now', 'now');`);
    const before = readFileSync(filename);
    await expect(open()).rejects.toThrow(
      'Inline artifact content requires verified blob migration',
    );
    expect(readFileSync(filename)).toEqual(before);
  });

  it('refuses an existing named index that would defeat required uniqueness', async () => {
    seed(
      'DROP INDEX idx_store_public; CREATE INDEX idx_store_public ON store(value);',
    );
    const before = readFileSync(filename);
    await expect(open()).rejects.toThrow(
      'Incompatible desktop index idx_store_public',
    );
    expect(readFileSync(filename)).toEqual(before);
    expect(() =>
      inspectDesktopRecovery(Uint8Array.from(before).buffer),
    ).toThrow('Incompatible desktop index');
  });
  it('rolls back every additive schema change when migration is interrupted', async () => {
    seed(`INSERT INTO schema_version VALUES (2);
      INSERT INTO settings VALUES ('preserved', 'legacy');
      DROP TABLE store; DROP TABLE working_copies; DROP TABLE task_merges;
      ALTER TABLE cruxes DROP COLUMN deleted;`);
    const exec = Database.prototype.exec;
    jest.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: unknown,
      sql: unknown,
    ) {
      const result = exec.call(this, sql);
      if (sql === 'ALTER TABLE cruxes ADD COLUMN deleted TEXT')
        throw new Error('Injected migration interruption');
      return result;
    });
    await expect(open()).rejects.toThrow('Injected migration interruption');
    jest.restoreAllMocks();
    const retained = new Database(filename, { readonly: true });
    try {
      expect(
        retained.prepare('SELECT version FROM schema_version').all(),
      ).toEqual([{ version: 2 }]);
      expect(
        retained
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('store', 'working_copies', 'task_merges')",
          )
          .all(),
      ).toEqual([]);
      expect(
        retained
          .prepare(
            "SELECT name FROM pragma_table_info('cruxes') WHERE name = 'deleted'",
          )
          .all(),
      ).toEqual([]);
      expect(
        retained
          .prepare(
            "SELECT name FROM pragma_table_info('dimensions') WHERE name = 'deleted'",
          )
          .all(),
      ).toEqual([]);
      expect(
        retained
          .prepare("SELECT value FROM settings WHERE key = 'preserved'")
          .get(),
      ).toEqual({ value: 'legacy' });
    } finally {
      retained.close();
    }
    await open();
    expect(await owner.get('SELECT version FROM schema_version')).toEqual({
      version: 4,
    });
  });
  it.each([
    [
      'ALTER TABLE dimensions ADD COLUMN deleted INTEGER',
      'Incompatible desktop column dimensions.deleted',
    ],
    [
      'INSERT INTO schema_version VALUES (4); ALTER TABLE cruxes DROP COLUMN deleted',
      'missing cruxes.deleted',
    ],
    [
      'INSERT INTO schema_version VALUES (2), (4)',
      'Unsupported desktop schema version',
    ],
  ])('refuses incompatible schema state: %s', async (sql, message) => {
    seed(sql);
    const before = readFileSync(filename);
    await expect(open()).rejects.toThrow(message);
    expect(readFileSync(filename)).toEqual(before);
  });

  it('refuses missing table-level uniqueness without attempting to rebuild user rows', async () => {
    seed('', schema.replace('slug TEXT UNIQUE', 'slug TEXT'));
    const before = readFileSync(filename);
    await expect(open()).rejects.toThrow(
      'Missing desktop uniqueness constraint in cruxes',
    );
    expect(readFileSync(filename)).toEqual(before);
  });
});
