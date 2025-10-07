import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  // Change key column type from text to varchar(255) for authors
  await knex.schema.alterTable('authors', (table) => {
    table.string('key', 255).notNullable().alter();
  });

  // Change key column type from text to varchar(255) for cruxes
  await knex.schema.alterTable('cruxes', (table) => {
    table.string('key', 255).notNullable().alter();
  });

  // Change key column type from text to varchar(255) for paths
  await knex.schema.alterTable('paths', (table) => {
    table.string('key', 255).notNullable().alter();
  });

  // Change key column type from text to varchar(255) for themes
  await knex.schema.alterTable('themes', (table) => {
    table.string('key', 255).notNullable().alter();
  });
}


export async function down(knex: Knex): Promise<void> {
  // Revert key column type from varchar(255) back to text for themes
  await knex.schema.alterTable('themes', (table) => {
    table.text('key').notNullable().alter();
  });

  // Revert key column type from varchar(255) back to text for paths
  await knex.schema.alterTable('paths', (table) => {
    table.text('key').notNullable().alter();
  });

  // Revert key column type from varchar(255) back to text for cruxes
  await knex.schema.alterTable('cruxes', (table) => {
    table.text('key').notNullable().alter();
  });

  // Revert key column type from varchar(255) back to text for authors
  await knex.schema.alterTable('authors', (table) => {
    table.text('key').notNullable().alter();
  });
}

