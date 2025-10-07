import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  // Add key column to accounts
  await knex.schema.alterTable('accounts', (table) => {
    table.string('key', 255).notNullable().unique();
    table.index('key', 'idx_accounts_key');
  });

  // Add key column to tags
  await knex.schema.alterTable('tags', (table) => {
    table.string('key', 255).notNullable().unique();
    table.index('key', 'idx_tags_key');
  });

  // Add key column to dimensions
  await knex.schema.alterTable('dimensions', (table) => {
    table.string('key', 255).notNullable().unique();
    table.index('key', 'idx_dimensions_key');
  });

  // Add key column to markers
  await knex.schema.alterTable('markers', (table) => {
    table.string('key', 255).notNullable().unique();
    table.index('key', 'idx_markers_key');
  });
}


export async function down(knex: Knex): Promise<void> {
  // Remove key column from markers
  await knex.schema.alterTable('markers', (table) => {
    table.dropIndex('key', 'idx_markers_key');
    table.dropColumn('key');
  });

  // Remove key column from dimensions
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropIndex('key', 'idx_dimensions_key');
    table.dropColumn('key');
  });

  // Remove key column from tags
  await knex.schema.alterTable('tags', (table) => {
    table.dropIndex('key', 'idx_tags_key');
    table.dropColumn('key');
  });

  // Remove key column from accounts
  await knex.schema.alterTable('accounts', (table) => {
    table.dropIndex('key', 'idx_accounts_key');
    table.dropColumn('key');
  });
}

