import type { Knex } from 'knex';

/** Durable intent precedes external payment mutations. Neither table contains card data. */
export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('billing_account_state', (t) => {
    t.uuid('account_id')
      .primary()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.timestamp('closing_at');
  });
  await db.schema.createTable('billing_checkout_attempts', (t) => {
    t.uuid('account_id')
      .primary()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    t.uuid('id').notNullable().unique();
    t.text('provider').notNullable();
    t.jsonb('request').notNullable();
    t.text('status').notNullable().defaultTo('preparing');
    t.text('session_id');
    t.text('session_url');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  });
}
export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable('billing_checkout_attempts');
  await db.schema.dropTable('billing_account_state');
}
