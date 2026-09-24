import { EDIT_HISTORY_SCHEMA } from './edit-history';
import { FILE_CONTENT_SCHEMA } from './file-content.schema';
import type { Knex } from 'knex';
import { DESKTOP_SCHEMA_SQL } from './desktop-ddl';
import { prepareDesktopGraph } from '../common/database/sqlite-graph';

/** Fresh API schema, including native file content heads. No legacy conversion. */

export async function bootstrapDesktopDatabase(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    const connection = await trx.client.acquireConnection();
    try {
      // All DDL executes on this transaction's owned native connection.
      connection.exec(
        `${DESKTOP_SCHEMA_SQL}\n${FILE_CONTENT_SCHEMA};\n${EDIT_HISTORY_SCHEMA};\nINSERT INTO schema_version (version) VALUES (7);`,
      );
    } finally {
      await trx.client.releaseConnection(connection);
    }
    await prepareDesktopGraph(trx);
  });
}
