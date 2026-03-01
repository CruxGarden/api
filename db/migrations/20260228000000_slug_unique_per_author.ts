import type { Knex } from 'knex';

/**
 * Change slug uniqueness from global to per-author (excluding deleted rows).
 *
 * The public URL pattern is /@username/slug, so slugs only need to be
 * unique within a single author's non-deleted cruxes.
 */
export async function up(knex: Knex): Promise<void> {
  // Drop the global unique constraint on slug
  await knex.raw('ALTER TABLE cruxes DROP CONSTRAINT IF EXISTS cruxes_slug_key');

  // Add a partial unique index: unique per author, only for non-deleted rows
  await knex.raw(
    'CREATE UNIQUE INDEX cruxes_author_slug_unique ON cruxes (author_id, slug) WHERE deleted IS NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  // Drop the partial unique index
  await knex.raw('DROP INDEX IF EXISTS cruxes_author_slug_unique');

  // Restore the global unique constraint
  await knex.raw(
    'ALTER TABLE cruxes ADD CONSTRAINT cruxes_slug_key UNIQUE (slug)',
  );
}
