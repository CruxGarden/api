import { createHash } from 'crypto';
import {
  inspectDesktopRecovery,
  openDesktopRecovery,
  DesktopRecoveryInspection,
} from './desktop-recovery';

/** Host supplies durable blob storage. Null means absent; other read errors must propagate. */
export interface DesktopContentStore {
  read(fingerprint: string): Promise<Uint8Array | null>;
  /** Write atomically and retain existing content throughout conversion/replacement. */
  write(fingerprint: string, bytes: Uint8Array): Promise<void>;
}
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function payload(row: { id: unknown; content: unknown; fingerprint: unknown }) {
  if (typeof row.id !== 'string' || !row.id)
    throw new Error('Invalid inline artifact identity');
  // Preserve the legacy worker's stored-value semantics, including UTF-8 strings
  // tagged with other encodings. Never reinterpret/decode their bytes here.
  const bytes =
    typeof row.content === 'string'
      ? Buffer.from(row.content, 'utf8')
      : row.content instanceof Uint8Array
        ? row.content
        : null;
  if (!bytes) throw new Error('Unsupported inline artifact content');
  const fingerprint = hash(bytes);
  if (row.fingerprint !== null && row.fingerprint !== fingerprint)
    throw new Error('Inline artifact fingerprint failed integrity check');
  return { bytes, fingerprint };
}
function verify(fingerprint: string, bytes: Uint8Array | null): void {
  if (bytes === null)
    throw new Error(`Missing recovery content: ${fingerprint}`);
  if (!(bytes instanceof Uint8Array) || hash(bytes) !== fingerprint)
    throw new Error(`Recovery content failed integrity check: ${fingerprint}`);
}

/**
 * Prepare a detached image, verifying persisted content before releasing inline
 * copies. Never opens/replaces the working database. Failure leaves the supplied
 * image intact; successfully staged blobs remain available for a retry. The host
 * must exclude concurrent blob removal until its replacement has completed.
 */
export async function prepareDesktopContent(
  data: ArrayBuffer,
  store: DesktopContentStore,
): Promise<DesktopRecoveryInspection> {
  // Copy and validate synchronously, before any host callbacks can yield.
  const db = openDesktopRecovery(data, true);
  try {
    const hasContent = db
      .prepare(
        "SELECT 1 FROM pragma_table_info('artifacts') WHERE name = 'content'",
      )
      .get();
    if (hasContent) {
      // A legacy conversion must not execute opaque side effects while fixing
      // fingerprints; unknown extensions require an explicit compatibility reader.
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'artifacts' LIMIT 1",
          )
          .get()
      )
        throw new Error('Inline conversion does not support artifact triggers');
      const rows = db.prepare(
        'SELECT id, fingerprint, content FROM artifacts WHERE content IS NOT NULL',
      );
      // Check every source before writing anything; iterate to avoid retaining a
      // second complete collection of file payloads in memory.
      const updates: { id: string; fingerprint: string }[] = [];
      for (const row of rows.iterate())
        updates.push({ id: row.id, fingerprint: payload(row).fingerprint });
      for (const row of rows.iterate()) {
        const { bytes, fingerprint } = payload(row);
        const existing = await store.read(fingerprint);
        if (existing === null) {
          await store.write(fingerprint, bytes);
          verify(fingerprint, await store.read(fingerprint));
        } else verify(fingerprint, existing);
      }
      // All inline bytes have survived a read-back. Only the private image changes.
      db.transaction(() => {
        const update = db.prepare(
          'UPDATE artifacts SET fingerprint = ? WHERE id = ?',
        );
        for (const row of updates) update.run(row.fingerprint, row.id);
        db.exec('ALTER TABLE artifacts DROP COLUMN content');
      })();
    }
    const prepared = inspectDesktopRecovery(
      Uint8Array.from(db.serialize()).buffer,
    );
    // Include already-external history and avatars, and catch content disappearing
    // during staging. No usable converted image escapes without complete content.
    for (const fingerprint of prepared.fingerprints)
      verify(fingerprint, await store.read(fingerprint));
    return prepared;
  } finally {
    db.close();
  }
}
