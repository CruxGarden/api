import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tags', (table) => {
    table.boolean('system').notNullable().defaultTo(false);
  });

  await knex.raw('CREATE INDEX idx_tags_system ON tags (system)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_tags_system');

  await knex.schema.alterTable('tags', (table) => {
    table.dropColumn('system');
  });
}

