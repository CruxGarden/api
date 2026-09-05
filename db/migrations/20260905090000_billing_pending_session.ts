import type { Knex } from 'knex';

/**
 * The checkout session an account most recently opened. Sync can recover the
 * customer and subscription from it when the webhook never arrived (a local
 * API, a missed delivery), so a paid account is never stuck on Free waiting
 * for Stripe to call back. Cleared once the subscription is applied.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (t) => {
    t.text('pending_session_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (t) => {
    t.dropColumn('pending_session_id');
  });
}
