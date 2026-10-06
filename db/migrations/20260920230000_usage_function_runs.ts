import type { Knex } from 'knex';

/**
 * Crux Functions consume usage (CRUX-FUNCTIONS-PLAN F0 metering): every
 * handler run — an HTTP call, an event's handler, a Store hook — counts on
 * the crux's daily Store row as a run and its milliseconds, and counts
 * toward the plan's Store-request budget.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('usage_store_daily', (t) => {
    t.integer('fn_calls').notNullable().defaultTo(0);
    t.bigInteger('fn_ms').notNullable().defaultTo(0);
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('usage_store_daily', (t) => {
    t.dropColumn('fn_calls');
    t.dropColumn('fn_ms');
  });
}
