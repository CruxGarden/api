import type { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('sync_account_state', (t) => {
    t.uuid('account_id')
      .primary()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.timestamp('admitted_at', { useTz: true })
      .notNullable()
      .defaultTo(db.fn.now());
  });
  await db.schema.createTable('sync_heads', (t) => {
    t.uuid('account_id')
      .notNullable()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.text('kind').notNullable();
    t.text('object_id').notNullable();
    t.uuid('revision_id').notNullable();
    t.text('status').notNullable();
    t.text('storage_path');
    t.bigInteger('size').notNullable();
    t.text('slug');
    t.text('title');
    t.timestamp('updated_at', { useTz: true }).notNullable();
    t.primary(['account_id', 'kind', 'object_id']);
  });
  await db.schema.createTable('sync_uploads', (t) => {
    t.uuid('revision_id').primary();
    t.uuid('account_id')
      .notNullable()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.text('kind').notNullable();
    t.text('object_id').notNullable();
    t.text('storage_path').notNullable();
    t.text('state').notNullable(); // uploading, stored, retired
    t.timestamp('started_at', { useTz: true })
      .notNullable()
      .defaultTo(db.fn.now());
    t.index(['account_id', 'kind', 'object_id']);
  });
  await db.schema.createTable('sync_recoveries', (t) => {
    t.uuid('revision_id').primary();
    t.uuid('account_id')
      .notNullable()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.text('storage_path').notNullable();
    t.text('reason').notNullable();
    t.timestamp('reconciled_at', { useTz: true })
      .notNullable()
      .defaultTo(db.fn.now());
  });
}
export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable('sync_recoveries');
  await db.schema.dropTable('sync_uploads');
  await db.schema.dropTable('sync_heads');
  await db.schema.dropTable('sync_account_state');
}
