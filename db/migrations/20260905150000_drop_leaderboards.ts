import type { Knex } from 'knex';

/**
 * The 5Ws leaderboard lives in the crux itself — the Crux Store — not in a
 * bespoke API table (Daniel, 2026-09-05: "crux garden shouldn't have to add
 * any other backend for this"). The table from 20260905120000 goes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('leaderboard_entries');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.createTable('leaderboard_entries', (t) => {
    t.uuid('crux_id').notNullable();
    t.date('day').notNullable();
    t.uuid('account_id').notNullable();
    t.text('name').notNullable();
    t.integer('score').notNullable();
    t.integer('seconds').notNullable();
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['crux_id', 'day', 'account_id']);
  });
}
