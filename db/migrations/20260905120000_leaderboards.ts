import type { Knex } from 'knex';

/**
 * 5Ws daily leaderboards (ADR 0016). One row per account per crux (a Shelf)
 * per UTC day; the first round of the day counts, later ones are practice.
 * Entries are account-scoped — a valid, verified email is the price of a
 * place on the board — and written only by the API, never by a public key.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('leaderboard_entries', (t) => {
    t.uuid('crux_id').notNullable();
    t.date('day').notNullable();
    t.uuid('account_id').notNullable();
    t.text('name').notNullable();
    t.integer('score').notNullable();
    t.integer('seconds').notNullable();
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['crux_id', 'day', 'account_id']);
    t.index(['crux_id', 'day', 'score', 'seconds'], 'idx_leaderboard_rank');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('leaderboard_entries');
}
