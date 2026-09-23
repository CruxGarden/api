/** Fresh API content schema; no legacy conversion. */
export const FILE_CONTENT_SCHEMA = `CREATE TABLE file_content_heads (
  crux_id TEXT PRIMARY KEY NOT NULL,
  format_version INTEGER NOT NULL,
  root TEXT NOT NULL,
  revision INTEGER NOT NULL
)`;
