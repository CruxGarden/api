import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('themes', (table) => {
    table.string('border_color').nullable();
    table.string('border_width').nullable();
  });
}


export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('themes', (table) => {
    table.dropColumn('border_color');
    table.dropColumn('border_width');
  });
}

