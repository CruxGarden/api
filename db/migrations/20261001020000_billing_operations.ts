import type { Knex } from 'knex';

/** Hosted operational state only: never exported as Garden content. */
export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('billing_checkout_resolutions', (t) => {
    t.uuid('attempt_id').primary();
    t.uuid('account_id')
      .notNullable()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.uuid('operator_id').notNullable();
    t.text('provider').notNullable();
    t.text('review_reference').notNullable();
    t.timestamp('resolved_at').notNullable().defaultTo(db.fn.now());
  });
  await db.schema.createTable('billing_reconciliation', (t) => {
    t.uuid('account_id')
      .primary()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.timestamp('verified_at');
    t.timestamp('failed_at');
    t.text('failure_code');
    t.integer('failures').notNullable().defaultTo(0);
    t.timestamp('due_at').notNullable().defaultTo(db.fn.now());
    t.uuid('lease_id');
    t.timestamp('lease_until');
    t.index(['due_at', 'lease_until']);
  });
  await db.schema.createTable('billing_delivery_failures', (t) => {
    t.text('event_id').primary();
    t.text('provider').notNullable();
    t.text('event_type').notNullable();
    t.text('failure_code').notNullable();
    t.integer('attempts').notNullable().defaultTo(1);
    t.timestamp('failed_at').notNullable();
    t.timestamp('recovered_at');
    t.index(['recovered_at', 'failed_at']);
  });
  await db.schema.createTable('billing_notifications', (t) => {
    t.uuid('id').primary();
    t.uuid('account_id')
      .notNullable()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.text('dedupe_key').unique();
    t.text('subject').notNullable();
    t.text('body').notNullable();
    t.jsonb('condition');
    t.text('outcome');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
    t.timestamp('due_at').notNullable().defaultTo(db.fn.now());
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('failure_code');
    t.uuid('lease_id');
    t.timestamp('lease_until');
    t.timestamp('sent_at');
    t.index(['sent_at', 'due_at']);
  });
}
export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable('billing_notifications');
  await db.schema.dropTable('billing_delivery_failures');
  await db.schema.dropTable('billing_reconciliation');
  await db.schema.dropTable('billing_checkout_resolutions');
}
