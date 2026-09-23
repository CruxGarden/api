import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as recovery from './desktop-recovery';
import { FileManifest, FileEntry } from './file-manifest';
import { FILE_CONTENT_SCHEMA } from './file-content.repository';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const objects = new Map<string, Uint8Array>();
  const store = {
    read: jest.fn(async (id: string) => objects.get(id) ?? null),
    write: jest.fn(async (id: string, bytes: Uint8Array) => {
      objects.set(id, Uint8Array.from(bytes));
    }),
  };
  const tree = new FileManifest(store);
  const files: FileEntry[] = Array.from({ length: 90 }, (_, i) => {
    const bytes = Buffer.from(`binary\0${i}`);
    const fingerprint = hash(bytes);
    objects.set(fingerprint, bytes);
    return {
      id: `file-${i}`,
      path: `dir/${i}`,
      fingerprint,
      size: bytes.length,
      mimeType: 'application/octet-stream',
      encoding: 'binary',
      mode: 0o644,
      attributes: {},
    };
  });
  const root = await tree.apply(
    null,
    files.map((put) => ({ put })),
  );
  const old = await tree.apply(null, [{ put: files[0] }]);
  const portrait = Buffer.from('portrait');
  const avatar = hash(portrait);
  objects.set(avatar, portrait);
  const db = new Database(':memory:');
  db.exec(schema);
  db.exec(FILE_CONTENT_SCHEMA);
  db.prepare('INSERT INTO file_content_heads VALUES (?, 1, ?, 1)').run(
    'current',
    root,
  );
  db.prepare('INSERT INTO file_content_heads VALUES (?, 1, ?, 3)').run(
    'retained',
    old,
  );
  db.prepare(
    "INSERT INTO authors (id, meta, created, updated) VALUES ('author', ?, 'now', 'now')",
  ).run(JSON.stringify({ avatarFingerprint: avatar }));
  db.exec(
    "CREATE TABLE extension_state (value TEXT); INSERT INTO extension_state VALUES ('keep exactly')",
  );
  const image = () => Uint8Array.from(db.serialize()).buffer;
  store.write.mockClear();
  store.read.mockClear();
  return { db, image, objects, store, root, old, avatar, files };
}
// The explicit asynchronous path must verify both transitive and legacy content.
const inspect = (
  data: ArrayBuffer,
  store: { read(id: string): Promise<Uint8Array | null> },
) => recovery.inspectDesktopManifestRecovery(data, store);

describe('manifest-aware detached recovery', () => {
  it('retains every tree object, file and legacy asset without changing supplied metadata', async () => {
    const f = await fixture();
    try {
      const data = f.image();
      const original = Buffer.from(data).toString('hex');
      expect(() => recovery.inspectDesktopRecovery(data)).toThrow(
        'manifest-aware',
      );
      const result = await inspect(data, f.store);
      expect(result.fingerprints).toEqual([...f.objects.keys()].sort());
      expect(Buffer.from(data).toString('hex')).toBe(original);
      const restored = new Database(Buffer.from(result.database));
      try {
        expect(
          restored.prepare('SELECT value FROM extension_state').get().value,
        ).toBe('keep exactly');
      } finally {
        restored.close();
      }
      expect(f.store.write).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it.each(['root', 'branch', 'file', 'portrait'])(
    'refuses missing %s bytes without losing the image; retry succeeds',
    async (kind) => {
      const f = await fixture();
      try {
        const branches = JSON.parse(
          Buffer.from(f.objects.get(f.root)!).toString(),
        ).children;
        const id =
          kind === 'root'
            ? f.root
            : kind === 'branch'
              ? branches[0].hash
              : kind === 'file'
                ? f.files[0].fingerprint
                : f.avatar;
        const bytes = f.objects.get(id)!;
        f.objects.delete(id);
        const data = f.image();
        const original = Buffer.from(data);
        await expect(inspect(data, f.store)).rejects.toThrow();
        expect(Buffer.from(data)).toEqual(original);
        f.objects.set(id, bytes);
        expect((await inspect(data, f.store)).fingerprints).toContain(id);
      } finally {
        f.db.close();
      }
    },
  );
  it.each(['root', 'file', 'portrait'])(
    'refuses corrupt %s bytes',
    async (kind) => {
      const f = await fixture();
      try {
        const id =
          kind === 'root'
            ? f.root
            : kind === 'file'
              ? f.files[0].fingerprint
              : f.avatar;
        f.objects.set(id, Buffer.from('corrupt'));
        await expect(inspect(f.image(), f.store)).rejects.toThrow();
      } finally {
        f.db.close();
      }
    },
  );
  it.each([
    'format_version = 2',
    'revision = 0',
    'revision = 1.5',
    "root = 'bad'",
    "crux_id = ''",
  ])('refuses invalid head %s before reading blobs', async (assignment) => {
    const f = await fixture();
    try {
      f.db.exec(
        `UPDATE file_content_heads SET ${assignment} WHERE crux_id = 'current'`,
      );
      await expect(inspect(f.image(), f.store)).rejects.toThrow(
        'Invalid recovery file content head',
      );
      expect(f.store.read).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('captures database bytes and the bound reader before awaiting host storage', async () => {
    const f = await fixture();
    try {
      const data = f.image();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const host = {
        objects: f.objects,
        async read(id: string) {
          await gate;
          return this.objects.get(id) ?? null;
        },
      };
      const pending = inspect(data, host);
      new Uint8Array(data).fill(0);
      host.read = async () => {
        throw new Error('replaced reader');
      };
      release();
      expect((await pending).fingerprints).toEqual(
        [...f.objects.keys()].sort(),
      );
    } finally {
      f.db.close();
    }
  });
  it('also verifies legacy-only images and preserves the old synchronous inspector', async () => {
    const f = await fixture();
    try {
      f.db.exec('DROP TABLE file_content_heads');
      expect(recovery.inspectDesktopRecovery(f.image()).fingerprints).toEqual([
        f.avatar,
      ]);
      expect((await inspect(f.image(), f.store)).fingerprints).toEqual([
        f.avatar,
      ]);
      f.objects.delete(f.avatar);
      await expect(inspect(f.image(), f.store)).rejects.toThrow(
        'Missing recovery content',
      );
    } finally {
      f.db.close();
    }
  });
});
