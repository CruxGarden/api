import type { Knex } from 'knex';

/**
 * Custom domain rows must outlive their crux. Unpublish hard-deletes the crux,
 * and the cascade took the soft-deleted domain rows with it — so the poller
 * never finished the CloudFront tenant delete (the domain kept serving the
 * republished bucket) and reconnecting could not revive the row with its
 * token. crux_id stays as a plain reference; a revive repoints it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE custom_domains DROP CONSTRAINT IF EXISTS custom_domains_crux_id_fkey;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DELETE FROM custom_domains
      WHERE crux_id NOT IN (SELECT id FROM cruxes);
    ALTER TABLE custom_domains
      ADD CONSTRAINT custom_domains_crux_id_fkey
      FOREIGN KEY (crux_id) REFERENCES cruxes(id) ON DELETE CASCADE;
  `);
}
