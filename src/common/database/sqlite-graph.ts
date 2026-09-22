import { Client, Knex } from 'knex';
import { isAbsolute } from 'path';

// Knex's SQLite driver accepts SQL primitives; API repositories supply JSON
// objects and Dates, just as they do to PostgreSQL. Keep that conversion here.
const BetterSqliteClient: typeof Client = require('knex/lib/dialects/better-sqlite3');

class SqliteGraphClient extends BetterSqliteClient {
  prepBindings(bindings: unknown[] = []): unknown[] {
    return bindings.map((value) => {
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'boolean') return Number(value);
      if (
        value !== null &&
        typeof value === 'object' &&
        !Buffer.isBuffer(value)
      ) {
        return JSON.stringify(value);
      }
      return value;
    });
  }
}

/** Decode row columns only. Crux data and nested metadata are user content. */
function decodeRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Buffer.isBuffer(row)) return row;
  const decoded = { ...row } as Record<string, unknown>;
  if (typeof decoded.meta === 'string') {
    // Do not silently replace corrupt metadata with an empty object.
    decoded.meta = JSON.parse(decoded.meta);
  }
  if (decoded.discoverable === 0 || decoded.discoverable === 1) {
    decoded.discoverable = Boolean(decoded.discoverable);
  }
  for (const column of ['created', 'updated', 'deleted']) {
    if (typeof decoded[column] === 'string') {
      const date = new Date(decoded[column]);
      if (!Number.isFinite(date.getTime())) {
        throw new Error(`Invalid SQLite graph timestamp in ${column}`);
      }
      decoded[column] = date;
    }
  }
  return decoded;
}

/**
 * SQLite support for the API graph repositories, not the entire hosted API.
 * Explicitly injected into DbService; no environment switch or desktop cutover.
 */
export function sqliteGraphConfig(filename: string): Knex.Config {
  if (filename !== ':memory:' && !isAbsolute(filename)) {
    throw new Error('A local graph database requires an absolute filename');
  }
  return {
    client: SqliteGraphClient,
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(
        connection: any,
        done: (error: Error | null, connection: any) => void,
      ) {
        try {
          connection.pragma('foreign_keys = ON');
          connection.pragma('busy_timeout = 5000');
          connection.pragma('journal_mode = WAL');
          done(null, connection);
        } catch (error) {
          done(error, connection);
        }
      },
    },
    postProcessResponse(result: unknown) {
      return Array.isArray(result) ? result.map(decodeRow) : decodeRow(result);
    },
  };
}

/**
 * Explicit, additive compatibility step for an existing desktop schema.
 * This is not a new schema/bootstrap or an automatic production migration.
 * Current renderer Dimension readers do not filter tombstones yet; do not
 * attach this adapter to a live desktop until those callers move to the API.
 */
export async function prepareDesktopGraph(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    for (const table of [
      'cruxes',
      'dimensions',
      'artifacts',
      'authors',
      'settings',
    ]) {
      if (!(await trx.schema.hasTable(table))) {
        throw new Error(`Desktop graph schema is missing ${table}`);
      }
    }
    if (!(await trx.schema.hasColumn('dimensions', 'deleted'))) {
      await trx.schema.alterTable('dimensions', (table) => {
        table.text('deleted').nullable();
      });
    }
  });
}
