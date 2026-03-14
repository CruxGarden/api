import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.boolean('discoverable').defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.dropColumn('discoverable');
  });
}
