import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('authors', (table) => {
    table.dropForeign('home_id');
    table.foreign('home_id').references('id').inTable('homes').onDelete('SET NULL').onUpdate('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('authors', (table) => {
    table.dropForeign('home_id');
    table.foreign('home_id').references('id').inTable('cruxes').onDelete('SET NULL').onUpdate('CASCADE');
  });
}
