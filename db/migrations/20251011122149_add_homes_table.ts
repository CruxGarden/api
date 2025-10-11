import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('homes', (table) => {
    table.uuid('id').primary();
    table.text('key').notNullable().unique();
    table.string('name').notNullable();
    table.text('description');

    table.boolean('primary').notNullable().defaultTo(false);

    table.string('type').notNullable();
    table.string('kind').notNullable();

    table.jsonb('meta');

    table.timestamp('created', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted', { useTz: true }).nullable();

    table.index('key', 'idx_homes_key');
    table.index('type', 'idx_homes_type');
    table.index('kind', 'idx_homes_kind');
    table.index('created', 'idx_homes_created');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('homes');
}
