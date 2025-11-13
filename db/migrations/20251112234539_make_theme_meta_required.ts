import type { Knex } from 'knex';

/**
 * Migration: Make theme meta column required
 *
 * Adds NOT NULL constraint to the meta column in themes table.
 * All themes must have styling metadata.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('themes', (table) => {
    table.jsonb('meta').notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('themes', (table) => {
    table.jsonb('meta').nullable().alter();
  });
}

