import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- Remove defaults from cruxes table
    ALTER TABLE cruxes ALTER COLUMN type DROP DEFAULT;
    ALTER TABLE cruxes ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE cruxes ALTER COLUMN visibility DROP DEFAULT;

    -- Remove default from paths table
    ALTER TABLE paths ALTER COLUMN type DROP DEFAULT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    -- Restore defaults to cruxes table
    ALTER TABLE cruxes ALTER COLUMN type SET DEFAULT 'text';
    ALTER TABLE cruxes ALTER COLUMN status SET DEFAULT 'living';
    ALTER TABLE cruxes ALTER COLUMN visibility SET DEFAULT 'unlisted';

    -- Restore default to paths table
    ALTER TABLE paths ALTER COLUMN type SET DEFAULT 'living';
  `);
}

