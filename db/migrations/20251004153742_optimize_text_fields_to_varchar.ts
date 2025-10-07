import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  // Accounts table
  await knex.schema.alterTable('accounts', (table) => {
    table.string('email', 255).notNullable().alter();
    table.string('role', 100).notNullable().alter();
  });

  // Authors table
  await knex.schema.alterTable('authors', (table) => {
    table.string('username', 100).notNullable().alter();
    table.string('display_name', 255).notNullable().alter();
  });

  // Cruxes table
  await knex.schema.alterTable('cruxes', (table) => {
    table.string('type', 100).notNullable().defaultTo('text').alter();
    table.string('slug', 255).notNullable().alter();
    table.string('status', 100).notNullable().defaultTo('living').alter();
    table.string('visibility', 100).notNullable().defaultTo('unlisted').alter();
  });

  // Dimensions table
  await knex.schema.alterTable('dimensions', (table) => {
    table.string('type', 255).notNullable().alter();
  });

  // Paths table
  await knex.schema.alterTable('paths', (table) => {
    table.string('slug', 255).notNullable().alter();
    table.string('type', 100).notNullable().defaultTo('living').alter();
    table.string('visibility', 100).notNullable().defaultTo('unlisted').alter();
    table.string('kind', 100).notNullable().alter();
  });

  // Tags table
  await knex.schema.alterTable('tags', (table) => {
    table.string('label', 100).notNullable().alter();
    table.string('resource_type', 255).notNullable().alter();
  });

  // Themes table
  await knex.schema.alterTable('themes', (table) => {
    table.string('title', 255).notNullable().alter();
    table.string('background_color', 255).alter();
    table.string('panel_color', 255).alter();
    table.string('text_color', 255).alter();
  });
}


export async function down(knex: Knex): Promise<void> {
  // Themes table - revert to character varying without length and text
  await knex.schema.alterTable('themes', (table) => {
    table.specificType('title', 'character varying').notNullable().alter();
    table.text('background_color').alter();
    table.text('panel_color').alter();
    table.text('text_color').alter();
  });

  // Tags table - revert to text
  await knex.schema.alterTable('tags', (table) => {
    table.text('label').notNullable().alter();
    table.text('resource_type').notNullable().alter();
  });

  // Paths table - revert to text and character varying
  await knex.schema.alterTable('paths', (table) => {
    table.text('slug').notNullable().alter();
    table.specificType('type', 'character varying').notNullable().defaultTo('living').alter();
    table.specificType('visibility', 'character varying').notNullable().defaultTo('unlisted').alter();
    table.specificType('kind', 'character varying(255)').notNullable().alter();
  });

  // Dimensions table - revert to text
  await knex.schema.alterTable('dimensions', (table) => {
    table.text('type').notNullable().alter();
  });

  // Cruxes table - revert to text and character varying
  await knex.schema.alterTable('cruxes', (table) => {
    table.specificType('type', 'character varying').notNullable().defaultTo('text').alter();
    table.text('slug').notNullable().alter();
    table.text('status').notNullable().defaultTo('living').alter();
    table.text('visibility').notNullable().defaultTo('unlisted').alter();
  });

  // Authors table - revert to character varying without length and text
  await knex.schema.alterTable('authors', (table) => {
    table.specificType('username', 'character varying').notNullable().alter();
    table.text('display_name').notNullable().alter();
  });

  // Accounts table - revert to character varying without length
  await knex.schema.alterTable('accounts', (table) => {
    table.specificType('email', 'character varying').notNullable().alter();
    table.specificType('role', 'character varying').notNullable().alter();
  });
}

