import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dimensions', (table) => {
    table.text('note');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropColumn('note');
  });
}
