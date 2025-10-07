import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.text('description');
  });
  await knex.schema.alterTable('dimensions', (table) => {
    table.integer('weight').nullable().index();
  });
  await knex.schema.raw(`
    ALTER TABLE dimensions
    DROP CONSTRAINT IF EXISTS check_dimensions_type,
    DROP CONSTRAINT IF EXISTS unique_source_target_type;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.dropColumn('description');
  });
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropColumn('weight');
  });
  await knex.schema.raw(`
    ALTER TABLE dimensions
    ADD CONSTRAINT check_dimensions_type CHECK (type IN ('gate', 'growth', 'garden', 'graft')),
    ADD CONSTRAINT unique_source_target_type UNIQUE (source_id, target_id, type);
  `);
}

