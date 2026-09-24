import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { inspectDesktopManifestRecovery } from './desktop-recovery';
const Database = require('better-sqlite3');

describe('fresh API file-content schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crux-fresh-content-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it('creates content-ready schema and edits/reopens without fixture DDL', async () => {
    const filename = join(dir, 'garden.db');
    let owner = await LocalGraphRuntime.create(filename);
    const objects = new Map<string, Uint8Array>();
    const store = {
      read: async (id: string) => objects.get(id) ?? null,
      write: async (id: string, bytes: Uint8Array) => {
        objects.set(id, Uint8Array.from(bytes));
      },
    };
    try {
      expect(await owner.get('SELECT version FROM schema_version')).toEqual({
        version: 6,
      });
      const id = await owner.createCrux({
        title: 'Fresh',
        slug: randomUUID(),
        authorId: randomUUID(),
        homeId: randomUUID(),
      });
      const bytes = Buffer.from('New model\0');
      const head = await owner.editFileContent(
        {
          cruxId: id,
          expected: null,
          changes: [
            {
              put: {
                id: 'file',
                path: 'hello.bin',
                fingerprint: createHash('sha256').update(bytes).digest('hex'),
                size: bytes.length,
                mimeType: 'application/octet-stream',
                encoding: 'binary',
                mode: 0o644,
                attributes: {},
              },
              bytes,
            },
          ],
        },
        store,
      );
      await owner.run(
        "CREATE TRIGGER refuse_marker BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'No rewrite'); END",
      );
      await owner.close();
      owner = await LocalGraphRuntime.open(filename);
      expect(await owner.fileContentHead(id)).toEqual(head);
      expect(
        Buffer.from(
          (await owner.readFileContent(
            { cruxId: id, expected: head, path: 'hello.bin' },
            store,
          ))!.bytes,
        ),
      ).toEqual(bytes);
      expect(
        (
          await inspectDesktopManifestRecovery(
            await owner.exportDatabase(),
            store,
          )
        ).fingerprints,
      ).toEqual([...objects.keys()].sort());
      expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
    } finally {
      await owner.close();
    }
  });
  it.each(['missing', 'shape', 'index', 'inline'])(
    'refuses damaged fresh schema (%s) without repairing it',
    async (damage) => {
      const filename = join(dir, 'garden.db');
      const owner = await LocalGraphRuntime.create(filename);
      await owner.close();
      const db = new Database(filename);
      try {
        if (damage === 'inline')
          db.exec('ALTER TABLE artifacts ADD COLUMN content TEXT');
        else if (damage === 'index') db.exec('DROP INDEX idx_cruxes_updated');
        else {
          db.exec('DROP TABLE file_content_heads');
          if (damage === 'shape')
            db.exec(
              'CREATE TABLE file_content_heads (crux_id TEXT, format_version INTEGER, root TEXT, revision INTEGER)',
            );
        }
      } finally {
        db.close();
      }
      const before = readFileSync(filename);
      await expect(
        LocalGraphRuntime.open(filename).then(async (opened) => {
          await opened.close();
        }),
      ).rejects.toThrow();
      expect(readFileSync(filename)).toEqual(before);
    },
  );
});
