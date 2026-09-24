import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';
const Database = require('better-sqlite3');

describe('current profile Task starting-state preservation', () => {
  it.each(['none', 'missing bytes', 'ignored write', 'missing Growth'])(
    'preserves schema-6 bases and extensions with %s then restarts or repairs',
    async (fault) => {
      const dir = mkdtempSync(join(tmpdir(), 'task-base-upgrade-'));
      const filename = join(dir, 'garden.db');
      const objects = new Map<string, Uint8Array>();
      const store: DesktopContentStore = {
        read: async (id) => objects.get(id) ?? null,
        write: async (id, bytes) => {
          objects.set(id, bytes);
        },
      };
      let owner = await LocalGraphRuntime.create(filename);
      try {
        const main = await owner.createCrux({
          slug: 'main',
          authorId: randomUUID(),
          homeId: randomUUID(),
        });
        const head = await owner.editFileContent(
          { cruxId: main, expected: null, changes: [] },
          store,
        );
        const growth = await owner.createGrowthSnapshot(
          {
            cruxId: main,
            expected: head,
            snapshotId: randomUUID(),
            parentId: null,
            meta: {
              messages: [
                { role: 'user', content: 'Keep historical conversation' },
              ],
            },
          },
          store,
        );
        const copy = randomUUID();
        await owner.close();
        const db = new Database(filename);
        db.exec(
          "ALTER TABLE working_copies RENAME COLUMN base_state TO base_snapshot_id; ALTER TABLE working_copies ADD COLUMN extension TEXT; CREATE TABLE extension_data (value TEXT); INSERT INTO extension_data VALUES ('Keep'); UPDATE schema_version SET version = 6;",
        );
        db.prepare(
          "INSERT INTO working_copies (id, crux_id, task_id, title, base_snapshot_id, meta, extension, created, updated) VALUES (?, ?, ?, 'Task', ?, '{}', 'Keep too', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')",
        ).run(copy, main, randomUUID(), growth.snapshot.id);
        db.prepare('INSERT INTO file_content_heads VALUES (?, 1, ?, 1)').run(
          copy,
          head.root,
        );
        if (fault === 'ignored write')
          db.exec(
            'CREATE TRIGGER refuse BEFORE UPDATE ON working_copies BEGIN SELECT RAISE(IGNORE); END;',
          );
        if (fault === 'missing Growth')
          db.prepare('UPDATE dimensions SET deleted=? WHERE target_id=?').run(
            'removed',
            growth.snapshot.id,
          );
        db.close();
        const bytes = objects.get(head.root)!;
        if (fault === 'missing bytes') objects.delete(head.root);
        if (fault !== 'none') {
          await expect(
            LocalGraphRuntime.open(filename, { contentStore: store }),
          ).rejects.toThrow();
          const retained = new Database(filename);
          expect(
            retained.prepare('SELECT version FROM schema_version').get()
              .version,
          ).toBe(6);
          expect(
            retained
              .prepare('SELECT base_snapshot_id FROM working_copies')
              .get().base_snapshot_id,
          ).toBe(growth.snapshot.id);
          retained.exec(
            'DROP TRIGGER IF EXISTS refuse; UPDATE dimensions SET deleted=NULL;',
          );
          retained.close();
          objects.set(head.root, bytes);
        }
        owner = await LocalGraphRuntime.open(filename, { contentStore: store });
        expect(await owner.get('SELECT version FROM schema_version')).toEqual({
          version: 7,
        });
        expect(await owner.workingCopyBase(copy, store)).toMatchObject({
          root: head.root,
          workspace: { parentId: growth.snapshot.id, messages: [] },
        });
        expect(await owner.get('SELECT extension FROM working_copies')).toEqual(
          { extension: 'Keep too' },
        );
        expect(await owner.get('SELECT value FROM extension_data')).toEqual({
          value: 'Keep',
        });
        expect(
          (await owner.execute(({ crux }) => crux.findById(growth.snapshot.id)))
            .meta.messages,
        ).toEqual([{ role: 'user', content: 'Keep historical conversation' }]);
        await owner.close();
        owner = await LocalGraphRuntime.open(filename);
        expect(await owner.workingCopyBase(copy, store)).toBeDefined();
      } finally {
        await owner.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
