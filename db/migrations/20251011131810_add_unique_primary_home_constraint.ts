import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE UNIQUE INDEX idx_homes_unique_primary
    ON homes ("primary")
    WHERE "primary" = true AND deleted IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_homes_unique_primary;
  `);
}
