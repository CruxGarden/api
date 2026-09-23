import type { Knex } from 'knex';
import { DESKTOP_SCHEMA_SQL } from './desktop-ddl';
import { prepareDesktopGraph } from '../common/database/sqlite-graph';

/** Transitional desktop v4 schema owned by the API for NEW files only.
 * Legacy fixture stays frozen for migration/preservation tests. No account,
 * billing or credential tables enter portable desktop content in this step.
 */

export async function bootstrapDesktopDatabase(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    const connection = await trx.client.acquireConnection();
    try {
      // All DDL executes on this transaction's owned native connection.
      connection.exec(
        `${DESKTOP_SCHEMA_SQL}\nINSERT INTO schema_version (version) VALUES (4);`,
      );
    } finally {
      await trx.client.releaseConnection(connection);
    }
    await prepareDesktopGraph(trx);
  });
}
