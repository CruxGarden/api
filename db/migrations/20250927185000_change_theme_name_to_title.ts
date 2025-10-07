import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Rename name column to title
  await knex.schema.alterTable('themes', (table) => {
    table.renameColumn('name', 'title');
  });

  // Update the unique constraint
  await knex.schema.raw(`
    ALTER TABLE themes
    DROP CONSTRAINT IF EXISTS themes_name_unique;
  `);

  await knex.schema.raw(`
    ALTER TABLE themes
    ADD CONSTRAINT themes_title_unique UNIQUE (title);
  `);

  // Update the index
  await knex.schema.raw(`
    DROP INDEX IF EXISTS idx_themes_name;
    CREATE INDEX idx_themes_title ON themes (title);
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Rename title back to name
  await knex.schema.alterTable('themes', (table) => {
    table.renameColumn('title', 'name');
  });

  // Restore the original constraint
  await knex.schema.raw(`
    ALTER TABLE themes
    DROP CONSTRAINT IF EXISTS themes_title_unique;
  `);

  await knex.schema.raw(`
    ALTER TABLE themes
    ADD CONSTRAINT themes_name_unique UNIQUE (name);
  `);

  // Restore the original index
  await knex.schema.raw(`
    DROP INDEX IF EXISTS idx_themes_title;
    CREATE INDEX idx_themes_name ON themes (name);
  `);
}