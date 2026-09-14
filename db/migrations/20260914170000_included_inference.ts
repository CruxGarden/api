import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('inference_requests', (t) => {
    t.uuid('id').primary();
    t.uuid('account_id').notNullable().references('id').inTable('accounts');
    t.text('model').notNullable();
    t.text('status').notNullable();
    t.bigInteger('reserved_microdollars').notNullable();
    t.bigInteger('charged_microdollars').notNullable();
    t.integer('input_tokens').nullable();
    t.integer('output_tokens').nullable();
    t.integer('cache_read_tokens').nullable();
    t.integer('cache_write_tokens').nullable();
    t.timestamp('created', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    t.timestamp('settled', { useTz: true }).nullable();
    t.timestamp('deleted', { useTz: true }).nullable();
    t.index(['account_id', 'created']);
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('inference_requests');
}
