import type { Knex } from 'knex';

/**
 * Crux Function schedules (CRUX-FUNCTIONS-PLAN F3): a published crux's
 * handler that exports `schedule` runs on the API's clock. One row per
 * (crux, handler); the scheduler claims due rows and advances next_run.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('function_schedules', (t) => {
    t.uuid('crux_id').notNullable();
    t.text('name').notNullable();
    t.text('schedule').notNullable();
    t.timestamp('next_run', { useTz: true }).notNullable();
    t.timestamp('last_run', { useTz: true }).nullable();
    t.text('last_status').nullable();
    t.timestamp('updated', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    t.primary(['crux_id', 'name']);
    t.index(['next_run']);
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('function_schedules');
}
