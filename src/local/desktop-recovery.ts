const Database = require('better-sqlite3');

export interface DesktopRecoveryInspection {
  /** Zero denotes the unversioned native desktop schema. */
  schemaVersion: number;
  /** Required content, including retained history and author avatars. */
  fingerprints: string[];
}

/** Inspect detached recovery bytes; never opens or mutates the working database. */
export function inspectDesktopRecovery(
  data: ArrayBuffer,
): DesktopRecoveryInspection {
  const db = new Database(Buffer.from(new Uint8Array(data)), {
    readonly: true,
  });
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
      schemaVersion > 4
    )
      throw new Error('Unsupported recovery schema version');
    const references: { fingerprint: string }[] = db
      .prepare(
        `
      SELECT fingerprint FROM artifacts WHERE fingerprint IS NOT NULL
      UNION
      SELECT json_extract(meta, '$.avatarFingerprint') AS fingerprint FROM authors
      WHERE json_extract(meta, '$.avatarFingerprint') IS NOT NULL
      ORDER BY fingerprint
    `,
      )
      .all();
    for (const { fingerprint } of references) {
      if (
        typeof fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(fingerprint)
      )
        throw new Error('Invalid recovery content fingerprint');
    }
    return {
      schemaVersion,
      fingerprints: references.map((row) => row.fingerprint),
    };
  } finally {
    db.close();
  }
}
