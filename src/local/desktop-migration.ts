import type { Knex } from 'knex';
import { DESKTOP_SCHEMA_SQL } from './desktop-ddl';
import { inspectDesktopSchema, needsDesktopMigration } from './desktop-schema';
import { prepareDesktopGraph } from '../common/database/sqlite-graph';

/** Additive legacy normalization; never extracts/drops opaque payload content. */
export async function migrateDesktopDatabase(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    const connection = await trx.client.acquireConnection();
    try {
      // Recheck inside the transaction before DDL; startup also checks read-only
      // before opening the writable pool and changing the journal mode.
      if (!needsDesktopMigration(connection)) return;
      const version = inspectDesktopSchema(connection);
      connection.exec(DESKTOP_SCHEMA_SQL);
      if (
        !connection
          .prepare(
            "SELECT 1 FROM pragma_table_info('cruxes') WHERE name = 'deleted'",
          )
          .get()
      )
        connection.exec('ALTER TABLE cruxes ADD COLUMN deleted TEXT');
      if (
        version === 0 &&
        !connection.prepare('SELECT version FROM schema_version').get()
      )
        connection.exec('INSERT INTO schema_version (version) VALUES (4)');
      else connection.exec('UPDATE schema_version SET version = 4');
    } finally {
      await trx.client.releaseConnection(connection);
    }
    // Includes the API's Dimension tombstones, in the same outer transaction.
    await prepareDesktopGraph(trx);
  });
}
