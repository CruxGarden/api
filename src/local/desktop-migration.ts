import { EDIT_HISTORY_SCHEMA } from './edit-history';
import type { Knex } from 'knex';
import {
  DesktopContentStore,
  externalizeDesktopContent,
} from './desktop-content';
import { PRE_TASK_STATE_SCHEMA_SQL } from './desktop-ddl';
import { retainedWorkspaceSchema } from './edit-history';
import { FileManifest } from './file-manifest';
import {
  inspectDesktopSchema,
  needsDesktopMigration,
  hasDesktopInlineContent,
} from './desktop-schema';
import { prepareDesktopGraph } from '../common/database/sqlite-graph';

/** Transactional legacy normalization; inline extraction requires verified host storage. */
export async function migrateDesktopDatabase(
  db: Knex,
  contentStore?: DesktopContentStore,
): Promise<void> {
  await db.transaction(async (trx) => {
    const connection = await trx.client.acquireConnection();
    try {
      // Recheck inside the transaction before DDL; startup also checks read-only
      // before opening the writable pool and changing the journal mode.
      if (!needsDesktopMigration(connection, !!contentStore)) return;
      if (contentStore && hasDesktopInlineContent(connection))
        await externalizeDesktopContent(connection, contentStore);
      if (!needsDesktopMigration(connection)) return;
      let version = inspectDesktopSchema(connection);
      if (version === 5) {
        connection.exec(
          `${EDIT_HISTORY_SCHEMA}; UPDATE schema_version SET version = 6;`,
        );
        version = 6;
      }
      if (version === 6) {
        const bases: { id: string; state: string }[] = [];
        for (const copy of connection
          .prepare('SELECT id, crux_id, base_snapshot_id FROM working_copies')
          .all()) {
          const base = connection
            .prepare(
              "SELECT c.*, h.root, h.format_version, h.revision FROM cruxes c JOIN file_content_heads h ON h.crux_id=c.id WHERE c.id=? AND c.kind='snapshot' AND c.deleted IS NULL",
            )
            .get(copy.base_snapshot_id);
          const main = connection
            .prepare('SELECT author_id, home_id FROM cruxes WHERE id=?')
            .get(copy.crux_id);
          const linked = connection
            .prepare(
              "SELECT id FROM dimensions WHERE source_id=? AND target_id=? AND type='growth' AND deleted IS NULL",
            )
            .get(copy.crux_id, copy.base_snapshot_id);
          const meta = base && JSON.parse(base.meta);
          if (
            !base ||
            !main ||
            !linked ||
            meta?.contentOwnerId !== copy.crux_id ||
            base.author_id !== main.author_id ||
            base.home_id !== main.home_id ||
            base.format_version !== 1 ||
            base.revision !== 1 ||
            !contentStore
          )
            throw new Error(
              'Cannot preserve the Task starting state: its retained base is unavailable',
            );
          const state = retainedWorkspaceSchema.parse({
            root: base.root,
            workspace: {
              parentId: base.id,
              messages: [],
              entryFile: meta.settings?.entryFile ?? null,
            },
          });
          await new FileManifest(contentStore).verify(state.root);
          bases.push({ id: copy.id, state: JSON.stringify(state) });
        }
        connection.exec(
          'ALTER TABLE working_copies RENAME COLUMN base_snapshot_id TO base_state',
        );
        for (const base of bases) {
          connection
            .prepare('UPDATE working_copies SET base_state=? WHERE id=?')
            .run(base.state, base.id);
          if (
            connection
              .prepare('SELECT base_state FROM working_copies WHERE id=?')
              .get(base.id)?.base_state !== base.state
          )
            throw new Error('Task starting state did not persist');
        }
        connection.exec('UPDATE schema_version SET version = 7');
        if (inspectDesktopSchema(connection) !== 7)
          throw new Error('Task starting-state schema did not persist');
        return;
      }
      connection.exec(PRE_TASK_STATE_SCHEMA_SQL);
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
