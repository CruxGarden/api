import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('attachments', (table) => {
    table.uuid('id').primary();
    table.text('key').notNullable().unique();

    table.string('type').notNullable();
    table.string('kind').notNullable();

    table.jsonb('meta');

    table.uuid('resource_id').notNullable();
    table.string('resource_type').notNullable();

    table.uuid('author_id').notNullable()
      .references('id').inTable('authors')
      .onDelete('CASCADE').onUpdate('CASCADE');

    table.string('encoding').notNullable();
    table.string('mime_type').notNullable();
    table.string('filename').notNullable();
    table.bigInteger('size').notNullable();

    table.timestamp('created', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted', { useTz: true }).nullable();

    table.index('key', 'idx_attachments_key');
    table.index('author_id', 'idx_attachments_author_id');
    table.index('type', 'idx_attachments_type');
    table.index('kind', 'idx_attachments_kind');
    table.index(['resource_id', 'resource_type'], 'idx_attachments_resource');
    table.index('created', 'idx_attachments_created');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('attachments');
}
