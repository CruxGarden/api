import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('authors', (table) => {
    table.uuid('home_id');
    table.foreign('home_id').references('id').inTable('cruxes').onDelete('SET NULL');
    table.index('home_id', 'idx_authors_home_id');
  });
}


export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('authors', (table) => {
    table.dropIndex('home_id', 'idx_authors_home_id');
    table.dropForeign('home_id');
    table.dropColumn('home_id');
  });
}

