import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.dropColumn('merged');
  });
}


export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cruxes', (table) => {
    table.timestamp('merged', { useTz: true }).nullable();
  });
}

