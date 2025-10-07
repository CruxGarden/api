import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('paths', (table) => {
    table.uuid('theme_id').nullable();
    table
      .foreign('theme_id')
      .references('id')
      .inTable('themes')
      .onUpdate('CASCADE')
      .onDelete('SET NULL');
  });
}


export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('paths', (table) => {
    table.dropForeign(['theme_id']);
    table.dropColumn('theme_id');
  });
}

