import type { Knex } from 'knex';

/** Removed markers retain their records but no longer occupy a live position. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE markers DROP CONSTRAINT unique_path_order;
    CREATE UNIQUE INDEX markers_live_path_order ON markers (path_id, "order") WHERE deleted IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // PostgreSQL refuses this downgrade if retained history repeats a position;
  // the migration transaction then rolls back rather than deleting history.
  await knex.raw(`
    DROP INDEX markers_live_path_order;
    ALTER TABLE markers ADD CONSTRAINT unique_path_order UNIQUE (path_id, "order");
  `);
}
