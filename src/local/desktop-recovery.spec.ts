import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolve } from 'path';
import { inspectDesktopRecovery } from './desktop-recovery';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);

function image(mutate?: (db: any) => void): ArrayBuffer {
  const db = new Database(':memory:');
  try {
    db.exec(schema);
    mutate?.(db);
    const bytes: Buffer = db.serialize();
    return Uint8Array.from(bytes).buffer;
  } finally {
    db.close();
  }
}

describe('detached desktop recovery inspection', () => {
  it('reads an exported image without changing its bytes or adding schema', () => {
    const bytes = image((db) => {
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('keep', 'original');
    });
    const original = Buffer.from(bytes).toString('hex');
    expect(inspectDesktopRecovery(bytes)).toEqual({
      database: expect.any(ArrayBuffer),
      schemaVersion: 0,
      fingerprints: [],
    });
    expect(Buffer.from(bytes).toString('hex')).toBe(original);
    const reopened = new Database(Buffer.from(bytes), { readonly: true });
    try {
      expect(reopened.prepare('SELECT value FROM settings').get()).toEqual({
        value: 'original',
      });
      expect(
        reopened
          .pragma('table_info(dimensions)')
          .some((c: any) => c.name === 'deleted'),
      ).toBe(false);
    } finally {
      reopened.close();
    }
  });
  it('finds unique file and avatar content across the full recovery image', () => {
    const file = 'a'.repeat(64);
    const avatar = 'b'.repeat(64);
    const bytes = image((db) => {
      for (const id of ['main-file', 'history-file'])
        db.prepare(
          `INSERT INTO artifacts (id, resource_id, author_id, home_id, fingerprint, created, updated)
          VALUES (?, ?, 'author', 'home', ?, 'now', 'now')`,
        ).run(id, id, file);
      db.prepare(
        `INSERT INTO authors (id, meta, created, updated) VALUES ('author', ?, 'now', 'now')`,
      ).run(JSON.stringify({ avatarFingerprint: avatar }));
    });
    expect(inspectDesktopRecovery(bytes).fingerprints).toEqual([file, avatar]);
  });

  it('retains historical portraits and Task journal bytes without Artifact rows', () => {
    const fingerprints = Array.from({ length: 9 }, (_, n) =>
      (n + 1).toString(16).repeat(64),
    );
    const bytes = image((db) => {
      db.prepare(
        "INSERT INTO cruxes (id, author_id, home_id, meta, created, updated) VALUES ('crux', 'author', 'home', ?, 'now', 'now')",
      ).run(
        JSON.stringify({
          authorSnapshots: { old: { avatarFingerprint: fingerprints[0] } },
          personaSnapshots: {
            old: {
              thumbnailFingerprint: fingerprints[1],
              thumbnailFingerprintLight: fingerprints[2],
            },
          },
        }),
      );
      db.prepare(
        "INSERT INTO working_copies (id, crux_id, task_id, title, base_snapshot_id, meta, created, updated) VALUES ('copy', 'crux', 'task', 'Task', 'base', ?, 'now', 'now')",
      ).run(
        JSON.stringify({
          authorSnapshots: { old: { avatarFingerprint: fingerprints[3] } },
        }),
      );
      db.prepare(
        "INSERT INTO task_merges VALUES ('review', 'crux', 'copy', 'candidate', 'cancelled', ?, 'now')",
      ).run(
        JSON.stringify({
          base: { 'base.txt': { fingerprint: fingerprints[4] } },
          main: { 'main.txt': { fingerprint: fingerprints[5] } },
          task: { 'task.txt': { fingerprint: fingerprints[6] } },
          manifest: { 'result.txt': { fingerprint: fingerprints[7] } },
          conflicts: [
            { path: 'conflict.bin', task: { fingerprint: fingerprints[8] } },
          ],
        }),
      );
    });
    expect(inspectDesktopRecovery(bytes).fingerprints).toEqual(fingerprints);
  });

  it('retains Mood assets, saved packages, theme tokens, portraits and audio from settings', () => {
    const fingerprints = Array.from({ length: 12 }, (_, n) =>
      (n + 1).toString(16).repeat(64),
    );
    const bytes = image((db) => {
      const settings = {
        'cruxgarden:backgroundImage': fingerprints[0],
        'cruxgarden:moodCover': fingerprints[1],
        'cruxgarden:persona': JSON.stringify({
          thumbnailFingerprint: fingerprints[2],
          thumbnailFingerprintLight: fingerprints[3],
        }),
        'cruxgarden:soundTrack': JSON.stringify({
          fingerprint: fingerprints[4],
        }),
        'cruxgarden:moodAssets': JSON.stringify([
          { fingerprint: fingerprints[5], name: 'Font', kind: 'font' },
        ]),
        'cruxgarden:moodThemeDark': JSON.stringify({
          paneBg: 'asset:' + fingerprints[6],
        }),
        'cruxgarden:moodThemeLight': JSON.stringify({
          paneBg: 'asset:' + fingerprints[7],
        }),
        'cruxgarden:moodUserPresets': JSON.stringify([
          { overrides: { paneBg: 'asset:' + fingerprints[8] } },
        ]),
        'cruxgarden:moodPackages': JSON.stringify([
          {
            cover: fingerprints[9],
            background: { image: fingerprints[10] },
            persona: { thumbnailFingerprint: fingerprints[2] },
            sound: { track: { fingerprint: fingerprints[4] } },
            assets: [{ fingerprint: fingerprints[5] }],
            theme: { overrides: { paneBg: 'asset:' + fingerprints[11] } },
          },
        ]),
        unrelated: JSON.stringify({ fingerprint: 'd'.repeat(64) }),
      };
      for (const [key, value] of Object.entries(settings))
        db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, value);
    });
    expect(inspectDesktopRecovery(bytes).fingerprints).toEqual(fingerprints);
  });

  it('accepts earlier databases without optional Task tables and ignores ordinary URLs', () => {
    const bytes = image((db) => {
      db.exec('DROP TABLE working_copies; DROP TABLE task_merges');
      db.prepare('INSERT INTO settings VALUES (?, ?)').run(
        'cruxgarden:soundTrack',
        JSON.stringify({ url: 'https://example.invalid/music.mp3' }),
      );
      db.prepare('INSERT INTO settings VALUES (?, ?)').run(
        'cruxgarden:moodThemeDark',
        JSON.stringify({ paneBg: '#ffffff' }),
      );
    });
    expect(inspectDesktopRecovery(bytes).fingerprints).toEqual([]);
  });

  it('refuses invalid typed historical portrait fingerprints', () => {
    const bytes = image((db) => {
      db.prepare(
        "INSERT INTO cruxes (id, author_id, home_id, meta, created, updated) VALUES ('crux', 'author', 'home', ?, 'now', 'now')",
      ).run(
        JSON.stringify({
          authorSnapshots: { old: { avatarFingerprint: '../outside' } },
        }),
      );
    });
    expect(() => inspectDesktopRecovery(bytes)).toThrow(
      'Invalid recovery content fingerprint',
    );
  });

  it.each(['cruxes', 'dimensions', 'settings'])(
    'refuses a recovery image missing %s',
    (table) => {
      expect(() =>
        inspectDesktopRecovery(image((db) => db.exec(`DROP TABLE ${table}`))),
      ).toThrow(`missing ${table}`);
    },
  );

  it.each([[8], [-1], [2, 4]])(
    'refuses unsupported or ambiguous version markers %j',
    (...versions) => {
      expect(() =>
        inspectDesktopRecovery(
          image((db) => {
            for (const version of versions)
              db.prepare('INSERT INTO schema_version VALUES (?)').run(version);
          }),
        ),
      ).toThrow('Unsupported recovery schema version');
    },
  );
  it.each([1, 2, 3, 4])(
    'recognizes legacy schema version %s without migrating it',
    (version) => {
      expect(
        inspectDesktopRecovery(
          image((db) =>
            db.prepare('INSERT INTO schema_version VALUES (?)').run(version),
          ),
        ).schemaVersion,
      ).toBe(version);
    },
  );

  it.each(['../outside', '', 42])(
    'refuses invalid content fingerprint %j',
    (fingerprint) => {
      expect(() =>
        inspectDesktopRecovery(
          image((db) => {
            db.prepare(
              `INSERT INTO authors (id, meta, created, updated) VALUES ('author', ?, 'now', 'now')`,
            ).run(JSON.stringify({ avatarFingerprint: fingerprint }));
          }),
        ),
      ).toThrow('Invalid recovery content fingerprint');
    },
  );
  it.each(['not sqlite', 'truncated sqlite'])('refuses %s input', (kind) => {
    const bytes =
      kind === 'not sqlite'
        ? new Uint8Array([1, 2, 3]).buffer
        : image().slice(0, 128);
    expect(() => inspectDesktopRecovery(bytes)).toThrow();
  });
  it('inspects an actual WAL export without modifying the supplied recovery bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crux-recovery-wal-'));
    const db = new Database(join(dir, 'source.db'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec(schema);
      db.prepare('INSERT INTO settings VALUES (?, ?)').run(
        'committed-in-wal',
        'preserved',
      );
      const bytes = Uint8Array.from(db.serialize()).buffer;
      const original = Buffer.from(bytes).toString('hex');
      expect(new Uint8Array(bytes)[18]).toBe(2);
      const inspected = inspectDesktopRecovery(bytes);
      expect(inspected.schemaVersion).toBe(0);
      expect(new Uint8Array(inspected.database)[18]).toBe(1);
      const detached = new Database(Buffer.from(inspected.database));
      try {
        expect(
          detached
            .prepare('SELECT value FROM settings WHERE key = ?')
            .get('committed-in-wal').value,
        ).toBe('preserved');
      } finally {
        detached.close();
      }
      expect(Buffer.from(bytes).toString('hex')).toBe(original);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
