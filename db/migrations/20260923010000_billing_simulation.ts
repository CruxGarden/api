import type { Knex } from 'knex';

/** Provider-side simulation state; operational data, never portable Garden content. */
export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('billing_simulation', (table) => {
    table.text('id').primary();
    table
      .uuid('account_id')
      .notNullable()
      .references('id')
      .inTable('accounts')
      .onDelete('CASCADE');
    table.text('kind').notNullable();
    table.text('provider_id').notNullable().unique();
    table.jsonb('data').notNullable();
    table.index(['account_id', 'kind']);
  });
}
export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable('billing_simulation');
}
