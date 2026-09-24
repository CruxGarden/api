import { editHistorySchema } from './edit-history';
import { createHash } from 'crypto';
import { FileManifest } from './file-manifest';
import type { DesktopContentStore } from './desktop-content';
import { desktopReferenceSql } from './desktop-reference-sql';
import { inspectDesktopSchema } from './desktop-schema';
const Database = require('better-sqlite3');

export interface DesktopRecoveryInspection {
  /** Detached SQLite image normalized for in-memory preparation. */
  database: ArrayBuffer;
  /** Zero denotes the unversioned native desktop schema. */
  schemaVersion: number;
  /** Required content, including retained history and author avatars. */
  fingerprints: string[];
}

/** Internal detached reader; writable only for explicit verified content conversion. */
export function openDesktopRecovery(
  data: ArrayBuffer,
  allowInlineContent = false,
): any {
  const bytes = Buffer.from(new Uint8Array(data));
  if (
    bytes.length < 100 ||
    bytes.subarray(0, 16).toString() !== 'SQLite format 3\0'
  )
    throw new Error('Invalid recovery SQLite header');
  // sqlite3_deserialize cannot open WAL-mode images. The snapshot already
  // includes committed WAL pages; normalize only our private copy's mode bytes.
  // https://sqlite.org/c3ref/deserialize.html
  if (bytes[18] === 2 && bytes[19] === 2) bytes[18] = bytes[19] = 1;
  if (bytes[18] !== 1 || bytes[19] !== 1)
    throw new Error('Unsupported recovery SQLite file format');
  const db = new Database(bytes, { readonly: !allowInlineContent });
  try {
    db.pragma('trusted_schema = OFF');
    const integrity = db.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('Recovery database failed SQLite integrity check');
    for (const table of [
      'cruxes',
      'dimensions',
      'artifacts',
      'authors',
      'settings',
      'schema_version',
    ]) {
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table)
      )
        throw new Error(`Recovery database is missing ${table}`);
    }
    const versions: { version: number }[] = db
      .prepare('SELECT version FROM schema_version')
      .all();
    const schemaVersion = versions[0]?.version ?? 0;
    // Native profiles are unversioned; the existing browser worker writes 1–4.
    // Recognizing a marker is not a promise to migrate arbitrary table shapes.
    if (
      versions.length > 1 ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 0 ||
      schemaVersion > 6
    )
      throw new Error('Unsupported recovery schema version');
    inspectDesktopSchema(db, allowInlineContent);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Inspect detached recovery bytes; never opens or mutates the working database. */
export function inspectDesktopRecovery(
  data: ArrayBuffer,
): DesktopRecoveryInspection {
  const db = openDesktopRecovery(data);
  try {
    const schemaVersion = inspectDesktopSchema(db);
    return {
      database: Uint8Array.from(db.serialize()).buffer,
      schemaVersion,
      fingerprints: desktopRecoveryFingerprints(db),
    };
  } finally {
    db.close();
  }
}

/** Internal reference scan shared by strict recovery and inline-aware preflight. */
export function desktopRecoveryFingerprints(db: any): string[] {
  const tables = new Set<string>(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row: { name: string }) => row.name),
  );
  if (
    tables.has('edit_history') &&
    db.prepare('SELECT 1 FROM edit_history LIMIT 1').get()
  )
    throw new Error('Edit history requires manifest-aware recovery');
  // This legacy scanner cannot enumerate transitive manifest objects/files.
  // Refuse rather than return a successful, incomplete archive inventory.
  if (
    tables.has('file_content_heads') &&
    db.prepare('SELECT 1 FROM file_content_heads LIMIT 1').get()
  )
    throw new Error('File content requires manifest-aware recovery');
  return legacyRecoveryFingerprints(db, tables);
}

function legacyRecoveryFingerprints(db: any, tables: Set<string>): string[] {
  const references: { fingerprint: string }[] = db
    .prepare(desktopReferenceSql(tables))
    .all();
  for (const { fingerprint } of references) {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
      throw new Error('Invalid recovery content fingerprint');
  }

  return references.map((row) => row.fingerprint);
}

/**
 * Explicit host-side inspection of candidate manifest images. This does not adopt
 * a schema or replace a database. The host must retain immutable content through
 * archive capture/replacement; this inventory is not a garbage-collection lease.
 */
export async function inspectDesktopManifestRecovery(
  data: ArrayBuffer,
  store: Pick<DesktopContentStore, 'read'>,
): Promise<DesktopRecoveryInspection> {
  // Both the image and host reader are captured before the first await.
  const read = store.read.bind(store);
  const db = openDesktopRecovery(data);
  let database: ArrayBuffer;
  let schemaVersion: number;
  let legacy: string[];
  let roots: string[];
  try {
    schemaVersion = inspectDesktopSchema(db);
    const tables = new Set<string>(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row: { name: string }) => row.name),
    );
    const heads = tables.has('file_content_heads')
      ? db
          .prepare(
            'SELECT crux_id, format_version, root, revision FROM file_content_heads',
          )
          .all()
      : [];
    const identities = new Set<string>();
    for (const head of heads) {
      if (
        typeof head.crux_id !== 'string' ||
        !head.crux_id ||
        identities.has(head.crux_id) ||
        head.format_version !== 1 ||
        typeof head.root !== 'string' ||
        !/^[a-f0-9]{64}$/.test(head.root) ||
        !Number.isSafeInteger(head.revision) ||
        head.revision < 1
      )
        throw new Error('Invalid recovery file content head');
      identities.add(head.crux_id);
    }
    // Include all retained rows, even if their owner is deleted or absent.
    // Recovery must not infer permission to discard content from graph lifecycle.
    roots = [
      ...new Set<string>(heads.map((head: { root: string }) => head.root)),
    ];
    if (tables.has('edit_history')) {
      const rows = db
        .prepare('SELECT crux_id, revision, checkpoints FROM edit_history')
        .all();
      for (const row of rows) {
        const history = editHistorySchema.parse({
          cruxId: row.crux_id,
          revision: row.revision,
          checkpoints: JSON.parse(row.checkpoints),
        });
        roots.push(...history.checkpoints.map((checkpoint) => checkpoint.root));
      }
      roots = [...new Set(roots)];
    }
    legacy = legacyRecoveryFingerprints(db, tables);
    database = Uint8Array.from(db.serialize()).buffer;
  } finally {
    db.close();
  }
  const fingerprints = new Set<string>();
  const tree = new FileManifest({
    read,
    write: async () => {
      throw new Error('Recovery inspection cannot write content');
    },
  });
  for (const root of roots)
    for (const fingerprint of await tree.verify(root))
      fingerprints.add(fingerprint);
  for (const fingerprint of legacy) {
    if (!fingerprints.has(fingerprint)) {
      const bytes = await read(fingerprint);
      if (bytes === null)
        throw new Error(`Missing recovery content: ${fingerprint}`);
      if (
        !(bytes instanceof Uint8Array) ||
        createHash('sha256').update(bytes).digest('hex') !== fingerprint
      )
        throw new Error(
          `Recovery content failed integrity check: ${fingerprint}`,
        );
      fingerprints.add(fingerprint);
    }
  }
  return { database, schemaVersion, fingerprints: [...fingerprints].sort() };
}
