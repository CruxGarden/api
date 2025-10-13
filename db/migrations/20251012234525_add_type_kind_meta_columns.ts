import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  // Fix key column datatype for homes (text -> varchar(255))
  await knex.schema.alterTable('homes', (table) => {
    table.string('key', 255).notNullable().alter();
  });

  // Fix key column datatype for attachments (text -> varchar(255))
  await knex.schema.alterTable('attachments', (table) => {
    table.string('key', 255).notNullable().alter();
  });

  // Add type, kind, meta to authors
  await knex.schema.alterTable('authors', (table) => {
    table.string('type');
    table.string('kind');
    table.jsonb('meta');
  });

  // Add kind to cruxes
  await knex.schema.alterTable('cruxes', (table) => {
    table.string('kind');
  });

  // Add kind, meta to dimensions
  await knex.schema.alterTable('dimensions', (table) => {
    table.string('kind');
    table.jsonb('meta');
  });

  // Add meta to paths
  await knex.schema.alterTable('paths', (table) => {
    table.jsonb('meta');
  });

  // Add type, kind, meta to themes
  await knex.schema.alterTable('themes', (table) => {
    table.string('type');
    table.string('kind');
    table.jsonb('meta');
  });
}


export async function down(knex: Knex): Promise<void> {
  // Drop columns from themes
  await knex.schema.alterTable('themes', (table) => {
    table.dropColumn('type');
    table.dropColumn('kind');
    table.dropColumn('meta');
  });

  // Drop meta from paths
  await knex.schema.alterTable('paths', (table) => {
    table.dropColumn('meta');
  });

  // Drop kind and meta from dimensions
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropColumn('kind');
    table.dropColumn('meta');
  });

  // Drop kind from cruxes
  await knex.schema.alterTable('cruxes', (table) => {
    table.dropColumn('kind');
  });

  // Drop type, kind, meta from authors
  await knex.schema.alterTable('authors', (table) => {
    table.dropColumn('type');
    table.dropColumn('kind');
    table.dropColumn('meta');
  });

  // Revert key column datatype for attachments (varchar(255) -> text)
  await knex.schema.alterTable('attachments', (table) => {
    table.text('key').notNullable().alter();
  });

  // Revert key column datatype for homes (varchar(255) -> text)
  await knex.schema.alterTable('homes', (table) => {
    table.text('key').notNullable().alter();
  });
}

