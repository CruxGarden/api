import type { Knex } from 'knex';

/**
 * The Crux Store goes from three buckets to two. `common` ("anyone reads, a
 * connected account writes") is now what `public` means, since every write
 * needs a signed-in account (Daniel, 2026-09-05: "maybe there is no such
 * thing as unauthorized writes, that way there's no abuse, or it can be
 * stopped"). Rows written as `common` become `public`; the API accepts the
 * old name as an alias and never stores it again.
 */
export async function up(knex: Knex): Promise<void> {
  await knex('store').where('mode', 'common').update({ mode: 'public' });
}

export async function down(): Promise<void> {
  // Nothing to undo: which public rows were once common is not recorded, and
  // both names now mean the same thing.
}
