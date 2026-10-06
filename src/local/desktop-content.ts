import { createHash } from 'crypto';
import {
  inspectDesktopRecovery,
  desktopRecoveryFingerprints,
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
    return await externalizeDesktopContent(db, store);
  } finally {
    db.close();
  }
}

/** Internal: caller owns the database and must roll back its transaction on failure. */
export async function externalizeDesktopContent(
  db: any,
  store: DesktopContentStore,
): Promise<DesktopRecoveryInspection> {
  const { hasContent, updates } = inspectInlineContent(db);
  if (hasContent) {
    const rows = db.prepare(
      'SELECT id, fingerprint, content FROM artifacts WHERE content IS NOT NULL',
    );
    for (const row of rows.iterate()) {
      const { bytes, fingerprint } = payload(row);
      const existing = await store.read(fingerprint);
      if (existing === null) {
        await store.write(fingerprint, bytes);
        verify(fingerprint, await store.read(fingerprint));
      } else verify(fingerprint, existing);
    }
    // All inline bytes have survived a read-back. The caller owns the outer
    // transaction at startup; detached preparation modifies only its private image.
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
}

/** Validate payloads without retaining a second full payload collection. */
function inspectInlineContent(db: any): {
  hasContent: boolean;
  updates: { id: string; fingerprint: string }[];
} {
  const hasContent = !!db
    .prepare(
      "SELECT 1 FROM pragma_table_info('artifacts') WHERE name = 'content'",
    )
    .get();
  const updates: { id: string; fingerprint: string }[] = [];
  if (hasContent) {
    for (const row of db
      .prepare(
        'SELECT id, fingerprint, content FROM artifacts WHERE content IS NOT NULL',
      )
      .iterate())
      updates.push({ id: row.id, fingerprint: payload(row).fingerprint });
    if (
      updates.length > 0 &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'artifacts' LIMIT 1",
        )
        .get()
    )
      throw new Error('Inline conversion does not support artifact triggers');
  }
  return { hasContent, updates };
}

/**
 * Preflight for incoming archives: inline bytes already supply their fingerprint,
 * even if shared by another record. Returned fingerprints require external blobs.
 * This never authorizes opening an inline image as the working database.
 */
export function inspectDesktopContent(data: ArrayBuffer): {
  inline: boolean;
  fingerprints: string[];
} {
  const db = openDesktopRecovery(data, true);
  try {
    const { updates } = inspectInlineContent(db);
    const supplied = new Set(updates.map((row) => row.fingerprint));
    return {
      inline: updates.length > 0,
      fingerprints: desktopRecoveryFingerprints(db).filter(
        (fp) => !supplied.has(fp),
      ),
    };
  } finally {
    db.close();
  }
}
