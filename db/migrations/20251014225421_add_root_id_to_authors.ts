import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('authors', (table) => {
    table.uuid('root_id').nullable();
    table.foreign('root_id').references('id').inTable('cruxes').onDelete('SET NULL').onUpdate('CASCADE');
    table.index('root_id', 'idx_authors_root_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('authors', (table) => {
    table.dropIndex('root_id', 'idx_authors_root_id');
    table.dropForeign('root_id');
    table.dropColumn('root_id');
  });
}

