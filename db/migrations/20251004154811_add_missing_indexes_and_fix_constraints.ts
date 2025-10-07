import type { Knex } from "knex";


export async function up(knex: Knex): Promise<void> {
  // Add missing indexes
  await knex.schema.alterTable('dimensions', (table) => {
    table.index('author_id', 'idx_dimensions_author_id');
  });

  await knex.schema.alterTable('tags', (table) => {
    table.index('author_id', 'idx_tags_author_id');
    table.index('resource_type', 'idx_tags_resource_type');
    table.index('resource_id', 'idx_tags_resource_id');
  });

  await knex.schema.alterTable('themes', (table) => {
    table.index('author_id', 'idx_themes_author_id');
  });

  // Fix themes.mode to use varchar(100) instead of varchar(5)
  await knex.schema.alterTable('themes', (table) => {
    table.string('mode', 100).alter();
  });

  // Update foreign key constraints to use SET NULL for author_id fields
  // First drop existing constraints, then recreate with SET NULL

  // cruxes.author_id - change from CASCADE to SET NULL
  await knex.schema.alterTable('cruxes', (table) => {
    table.dropForeign(['author_id'], 'cruxes_author_id_fkey');
  });
  await knex.schema.alterTable('cruxes', (table) => {
    table.foreign('author_id', 'cruxes_author_id_fkey')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('SET NULL');
  });

  // paths.author_id - change from CASCADE to SET NULL
  await knex.schema.alterTable('paths', (table) => {
    table.dropForeign(['author_id'], 'paths_author_id_fkey');
  });
  await knex.schema.alterTable('paths', (table) => {
    table.foreign('author_id', 'paths_author_id_fkey')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('SET NULL');
  });

  // markers.author_id - change from CASCADE to SET NULL
  await knex.schema.alterTable('markers', (table) => {
    table.dropForeign(['author_id'], 'markers_author_id_fkey');
  });
  await knex.schema.alterTable('markers', (table) => {
    table.foreign('author_id', 'markers_author_id_fkey')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('SET NULL');
  });

  // dimensions.author_id - add missing ON UPDATE CASCADE
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropForeign(['author_id'], 'dimensions_author_id_foreign');
  });
  await knex.schema.alterTable('dimensions', (table) => {
    table.foreign('author_id', 'dimensions_author_id_foreign')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('SET NULL');
  });
}


export async function down(knex: Knex): Promise<void> {
  // Revert foreign key constraints to original state

  // dimensions.author_id - remove ON UPDATE CASCADE
  await knex.schema.alterTable('dimensions', (table) => {
    table.dropForeign(['author_id'], 'dimensions_author_id_foreign');
  });
  await knex.schema.alterTable('dimensions', (table) => {
    table.foreign('author_id', 'dimensions_author_id_foreign')
      .references('id')
      .inTable('authors')
      .onDelete('SET NULL');
  });

  // markers.author_id - change back to CASCADE
  await knex.schema.alterTable('markers', (table) => {
    table.dropForeign(['author_id'], 'markers_author_id_fkey');
  });
  await knex.schema.alterTable('markers', (table) => {
    table.foreign('author_id', 'markers_author_id_fkey')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('CASCADE');
  });

  // paths.author_id - change back to CASCADE
  await knex.schema.alterTable('paths', (table) => {
    table.dropForeign(['author_id'], 'paths_author_id_fkey');
  });
  await knex.schema.alterTable('paths', (table) => {
    table.foreign('author_id', 'paths_author_id_fkey')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('CASCADE');
  });

  // cruxes.author_id - change back to CASCADE
  await knex.schema.alterTable('cruxes', (table) => {
    table.dropForeign(['author_id'], 'cruxes_author_id_fkey');
  });
  await knex.schema.alterTable('cruxes', (table) => {
    table.foreign('author_id', 'cruxes_author_id_fkey')
      .references('id')
      .inTable('authors')
      .onUpdate('CASCADE')
      .onDelete('CASCADE');
  });

  // Revert themes.mode to varchar(5)
  await knex.schema.alterTable('themes', (table) => {
    table.specificType('mode', 'character varying(5)').alter();
  });

  // Drop added indexes
  await knex.schema.alterTable('themes', (table) => {
    table.dropIndex('author_id', 'idx_themes_author_id');
  });

  await knex.schema.alterTable('tags', (table) => {
    table.dropIndex('resource_id', 'idx_tags_resource_id');
    table.dropIndex('resource_type', 'idx_tags_resource_type');
    table.dropIndex('author_id', 'idx_tags_author_id');
  });

  await knex.schema.alterTable('dimensions', (table) => {
    table.dropIndex('author_id', 'idx_dimensions_author_id');
  });
}

