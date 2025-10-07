import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dimensions', (table) => {
    table.uuid('author_id').nullable();
    table.foreign('author_id').references('id').inTable('authors').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropColumn('author_id');
  });
};
