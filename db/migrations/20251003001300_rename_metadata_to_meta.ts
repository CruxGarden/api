import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.renameColumn('metadata', 'meta');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.renameColumn('meta', 'metadata');
  });
}
