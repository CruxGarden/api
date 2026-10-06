const Database = require('better-sqlite3');

/** Reserved credentials belong to the host's encrypted store, never settings. */
export function isCredentialSetting(key: string): boolean {
  return (
    key.startsWith('cruxgarden:apiKey:') ||
    key.startsWith('cruxgarden:fn-secrets:') ||
    [
      'cruxgarden:authSession',
      'cruxgarden:accessToken',
      'cruxgarden:refreshToken',
      'cruxgarden:anthropicApiKey',
      'apiKey:anthropic',
    ].includes(key)
  );
}

/** Sanitize a detached export, preserving every byte of the live installation.
 * VACUUM is required: DELETE alone can retain plaintext in free SQLite pages.
 */
export function exportWithoutCredentials(source: Buffer): ArrayBuffer {
  const bytes = Buffer.from(source);
  // serialize includes committed WAL pages; deserialize needs rollback mode.
  bytes[18] = bytes[19] = 1;
  const copy = new Database(bytes);
  try {
    copy.pragma('trusted_schema = OFF');
    const rows = copy.prepare('SELECT key FROM settings').all() as {
      key: string;
    }[];
    const remove = copy.prepare('DELETE FROM settings WHERE key = ?');
    copy.transaction(() => {
      for (const { key } of rows) if (isCredentialSetting(key)) remove.run(key);
    })();
    copy.exec('VACUUM');
    return Uint8Array.from(copy.serialize()).buffer;
  } finally {
    copy.close();
  }
}
