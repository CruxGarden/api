import { DESKTOP_SCHEMA_SQL } from './desktop-ddl';
const Database = require('better-sqlite3');

/** Empty schema_version is the native app's legacy unversioned schema. */
export function desktopSchemaVersion(db: any): number {
  const versions: { version: number }[] = db
    .prepare('SELECT version FROM schema_version')
    .all();
  const version = versions[0]?.version ?? 0;
  if (
    versions.length > 1 ||
    !Number.isInteger(version) ||
    version < 0 ||
    version > 4
  )
    throw new Error('Unsupported desktop schema version');
  return version;
}

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}
let expected: Map<string, Column[]> | undefined;
let namedIndexes: { name: string; sql: string }[] = [];
let uniqueColumns: { table: string; columns: string }[] = [];
function indexColumns(db: any, name: string): string {
  return JSON.stringify(
    db
      .prepare(
        'SELECT name, coll, desc FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
      )
      .all(name),
  );
}
function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
function expectedColumns(): Map<string, Column[]> {
  if (expected) return expected;
  const reference = new Database(':memory:');
  try {
    reference.exec(DESKTOP_SCHEMA_SQL);
    expected = new Map(
      reference
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }: { name: string }) => [
          name,
          reference.prepare('SELECT * FROM pragma_table_info(?)').all(name),
        ]),
    );
    namedIndexes = reference
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      )
      .all();
    uniqueColumns = [...expected.keys()].flatMap((table) =>
      reference
        .prepare("SELECT name FROM pragma_index_list(?) WHERE origin = 'u'")
        .all(table)
        .map(({ name }: { name: string }) => ({
          table,
          columns: indexColumns(reference, name),
        })),
    );
    return expected;
  } finally {
    reference.close();
  }
}

/** Validate known columns without rewriting opaque extension tables or columns. */
export function inspectDesktopSchema(
  db: any,
  allowInlineContent = false,
): number {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row: { name: string }) => row.name),
  );
  for (const table of [
    'cruxes',
    'dimensions',
    'artifacts',
    'authors',
    'settings',
    'schema_version',
  ])
    if (!tables.has(table))
      throw new Error(`Desktop schema is missing ${table}`);
  const version = desktopSchemaVersion(db);
  for (const [table, columns] of expectedColumns()) {
    if (!tables.has(table)) {
      if (
        table === 'working_copies' ||
        table === 'task_merges' ||
        (table === 'store' && version < 3)
      )
        continue;
      throw new Error(`Desktop schema is missing ${table}`);
    }
    const actual: Column[] = db
      .prepare('SELECT * FROM pragma_table_info(?)')
      .all(table);
    for (const column of columns) {
      const found = actual.find((item) => item.name === column.name);
      if (!found) {
        if (
          column.name === 'deleted' &&
          (table === 'dimensions' || (table === 'cruxes' && version < 4))
        )
          continue;
        throw new Error(`Desktop schema is missing ${table}.${column.name}`);
      }
      if (
        found.type.toUpperCase() !== column.type ||
        found.pk !== column.pk ||
        found.notnull !== column.notnull
      )
        throw new Error(`Incompatible desktop column ${table}.${column.name}`);
    }
  }
  for (const index of namedIndexes) {
    const actual = db
      .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
      .get(index.name);
    if (
      actual &&
      (!actual.sql || normalizedSql(actual.sql) !== normalizedSql(index.sql))
    )
      throw new Error(`Incompatible desktop index ${index.name}`);
  }
  for (const constraint of uniqueColumns) {
    if (!tables.has(constraint.table)) continue;
    const indexes: { name: string }[] = db
      .prepare(
        'SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND partial = 0',
      )
      .all(constraint.table);
    if (
      !indexes.some(({ name }) => indexColumns(db, name) === constraint.columns)
    )
      throw new Error(
        `Missing desktop uniqueness constraint in ${constraint.table}`,
      );
  }
  const hasInlineContent = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('artifacts') WHERE name = 'content'",
    )
    .get();
  if (
    !allowInlineContent &&
    hasInlineContent &&
    db
      .prepare('SELECT 1 FROM artifacts WHERE content IS NOT NULL LIMIT 1')
      .get()
  )
    throw new Error('Inline artifact content requires verified blob migration');
  return version;
}

/** Refuse incompatible files before the writable pool can enable WAL or run DDL. */
export function inspectDesktopFile(filename: string): void {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    db.pragma('trusted_schema = OFF');
    inspectDesktopSchema(db);
  } finally {
    db.close();
  }
}
