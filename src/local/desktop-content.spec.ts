import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { prepareDesktopContent } from './desktop-content';
import { inspectDesktopRecovery } from './desktop-recovery';

const Database = require('better-sqlite3');
const schema = readFileSync(
  resolve(__dirname, '../../test/fixtures/desktop-schema.sql'),
  'utf8',
);
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function fixture(
  rows: { content: unknown; fingerprint?: string | null; encoding?: string }[],
  extra = '',
) {
  const db = new Database(':memory:');
  try {
    db.exec(schema);
    db.exec(`INSERT INTO schema_version VALUES (1);
      ALTER TABLE artifacts ADD COLUMN content BLOB;
      CREATE TABLE extension_payload (value BLOB);
      INSERT INTO extension_payload VALUES (X'00FF80');
      INSERT INTO settings VALUES ('preserved', 'original');`);
    rows.forEach((row, i) =>
      db
        .prepare(
          `INSERT INTO artifacts
      (id, resource_id, author_id, home_id, content, fingerprint, encoding, created, updated)
      VALUES (?, ?, 'author', 'home', ?, ?, ?, 'before', 'before')`,
        )
        .run(
          `file-${i}`,
          i ? 'history' : 'main',
          row.content,
          row.fingerprint ?? null,
          row.encoding ?? 'utf-8',
        ),
    );
    db.exec(extra);
    return Uint8Array.from(db.serialize()).buffer;
  } finally {
    db.close();
  }
}
function store() {
  const content = new Map<string, Uint8Array>();
  return {
    content,
    read: jest.fn(
      async (fingerprint: string) => content.get(fingerprint) ?? null,
    ),
    write: jest.fn(async (fingerprint: string, bytes: Uint8Array) => {
      content.set(fingerprint, Uint8Array.from(bytes));
    }),
  };
}

describe('verified detached inline content conversion', () => {
  it('preserves text, binary, empty, repeated history and opaque state without changing the supplied image', async () => {
    const binary = Buffer.from([0, 255, 128, 7]);
    const text = Buffer.from('Dream 🌱\n');
    const data = fixture([
      { content: text.toString() },
      { content: binary, fingerprint: hash(binary) },
      { content: '' },
      { content: text.toString() },
      { content: 'AA==', encoding: 'base64' },
    ]);
    const original = Buffer.from(data).toString('hex');
    const blobs = store();
    const converted = await prepareDesktopContent(data, blobs);
    expect(Buffer.from(data).toString('hex')).toBe(original);
    expect(() => inspectDesktopRecovery(data)).toThrow('Inline artifact');
    expect(converted.fingerprints).toEqual(
      [text, binary, Buffer.alloc(0), Buffer.from('AA==')].map(hash).sort(),
    );
    expect(blobs.write).toHaveBeenCalledTimes(4);
    const db = new Database(Buffer.from(converted.database));
    try {
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({
        version: 1,
      });
      expect(db.prepare('SELECT value FROM settings').get()).toEqual({
        value: 'original',
      });
      expect(
        db.prepare('SELECT hex(value) AS value FROM extension_payload').get(),
      ).toEqual({ value: '00FF80' });
      expect(
        db
          .prepare(
            'SELECT id, resource_id, fingerprint, updated FROM artifacts ORDER BY id',
          )
          .all(),
      ).toEqual(
        [text, binary, Buffer.alloc(0), text, Buffer.from('AA==')].map(
          (bytes, i) => ({
            id: `file-${i}`,
            resource_id: i ? 'history' : 'main',
            fingerprint: hash(bytes),
            updated: 'before',
          }),
        ),
      );
      expect(
        db
          .pragma('table_info(artifacts)')
          .some((row: any) => row.name === 'content'),
      ).toBe(false);
      expect(await prepareDesktopContent(converted.database, blobs)).toEqual(
        converted,
      );
      expect(blobs.write).toHaveBeenCalledTimes(4);
    } finally {
      db.close();
    }
  });
  it.each(['mismatch', 'number', 'future', 'trigger'])(
    'refuses %s before writing any content',
    async (kind) => {
      const rows = [
        { content: 'first' },
        {
          content: kind === 'number' ? 17 : 'later',
          fingerprint: kind === 'mismatch' ? 'a'.repeat(64) : null,
        },
      ];
      const data = fixture(
        rows,
        kind === 'future'
          ? 'UPDATE schema_version SET version = 99;'
          : kind === 'trigger'
            ? `CREATE TRIGGER side_effect AFTER UPDATE ON artifacts BEGIN DELETE FROM settings; END;`
            : '',
      );
      const before = Buffer.from(data).toString('hex');
      const blobs = store();
      await expect(prepareDesktopContent(data, blobs)).rejects.toThrow();
      expect(blobs.write).not.toHaveBeenCalled();
      expect(Buffer.from(data).toString('hex')).toBe(before);
    },
  );
  it.each(['write', 'short-read', 'read'])(
    'keeps the original retryable after %s failure',
    async (failure) => {
      const data = fixture([{ content: 'preserve me' }]);
      const before = Buffer.from(data).toString('hex');
      const blobs = store();
      if (failure === 'write')
        blobs.write.mockRejectedValueOnce(new Error('disk full'));
      if (failure === 'short-read')
        blobs.read
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(Buffer.from('short'));
      if (failure === 'read')
        blobs.read.mockRejectedValueOnce(new Error('permission denied'));
      await expect(prepareDesktopContent(data, blobs)).rejects.toThrow();
      expect(Buffer.from(data).toString('hex')).toBe(before);
      const converted = await prepareDesktopContent(data, blobs);
      expect(converted.fingerprints).toEqual([
        hash(Buffer.from('preserve me')),
      ]);
    },
  );
  it('refuses corrupt existing blobs without overwriting them', async () => {
    const data = fixture([{ content: 'preserve me' }]);
    const blobs = store();
    const fp = hash(Buffer.from('preserve me'));
    blobs.content.set(fp, Buffer.from('corrupt'));
    await expect(prepareDesktopContent(data, blobs)).rejects.toThrow(
      'integrity',
    );
    expect(blobs.write).not.toHaveBeenCalled();
    expect(blobs.content.get(fp)).toEqual(Buffer.from('corrupt'));
  });
  it('requires retained external files and avatars before returning a usable image', async () => {
    const retained = Buffer.from('external');
    const avatar = Buffer.from('avatar');
    const data = fixture(
      [{ content: 'inline' }, { content: null, fingerprint: hash(retained) }],
      `INSERT INTO authors (id, meta, created, updated) VALUES ('author', '{"avatarFingerprint":"${hash(avatar)}"}', 'now', 'now');`,
    );
    const blobs = store();
    await expect(prepareDesktopContent(data, blobs)).rejects.toThrow('Missing');
    blobs.content.set(hash(retained), retained);
    blobs.content.set(hash(avatar), avatar);
    const converted = await prepareDesktopContent(data, blobs);
    expect(converted.fingerprints).toEqual(
      [retained, avatar, Buffer.from('inline')].map(hash).sort(),
    );
  });
  it('captures the supplied image before asynchronous blob operations', async () => {
    const data = fixture([{ content: 'captured' }]);
    const blobs = store();
    const pending = prepareDesktopContent(data, blobs);
    new Uint8Array(data).fill(0);
    expect((await pending).fingerprints).toEqual([
      hash(Buffer.from('captured')),
    ]);
  });
});
