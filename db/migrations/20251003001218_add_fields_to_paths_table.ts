import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('paths', (table) => {
    table.string('kind').notNullable();
    table.uuid('entry').notNullable().references('id').inTable('markers');
  });
  await knex.schema.raw(`
    ALTER TABLE paths
    ADD CONSTRAINT check_paths_kind CHECK (kind IN ('guide', 'wander'));
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    ALTER TABLE paths
    DROP CONSTRAINT IF EXISTS check_paths_kind;
  `);
  await knex.schema.alterTable('paths', (table) => {
    table.dropColumn('kind');
    table.dropColumn('entry');
  });
};
