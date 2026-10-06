import type { Knex } from 'knex';

/**
 * ADR 0083: account suspension and billing edge states.
 *
 * - `accounts.suspended`/`suspended_reason`/`suspended_by`: an operator hold.
 *   Sign-in still works; hosted writes are refused (LimitsService/BillingService).
 * - `subscriptions.cancel_at`: Stripe's scheduled cancellation date, read in
 *   addition to `cancel_at_period_end`.
 * - `subscriptions.subscription_started_at`: the first time this account had a
 *   subscription that started (trialing or paid). Trial eligibility reads it;
 *   it is never cleared, so cancel/resubscribe cannot repeat a trial.
 * - `billing_notifications.recipient_email`: a notice addressed at enqueue time.
 *   Account closure soft-deletes the account, which otherwise suppresses queued
 *   mail; the closure email (with invoice links) must still be delivered. The
 *   address is cleared once the notice is finished.
 */
export async function up(db: Knex): Promise<void> {
  await db.schema.alterTable('accounts', (t) => {
    t.timestamp('suspended', { useTz: true }).nullable();
    t.text('suspended_reason').nullable();
    t.uuid('suspended_by').nullable();
  });
  await db.schema.alterTable('subscriptions', (t) => {
    t.timestamp('cancel_at', { useTz: true }).nullable();
    t.timestamp('subscription_started_at', { useTz: true }).nullable();
  });
  // Every stored subscription that reached a started state counts as history.
  // Before this migration `incomplete` also covered Stripe's incomplete_expired,
  // so it is conservatively treated as never started.
  await db('subscriptions')
    .whereNotNull('subscription_id')
    .whereIn('status', ['trialing', 'active', 'past_due', 'unpaid', 'canceled'])
    .update({
      subscription_started_at: db.raw(
        'coalesce(current_period_start, updated)',
      ),
    });
  await db.schema.alterTable('billing_notifications', (t) => {
    t.text('recipient_email').nullable();
  });
}

export async function down(db: Knex): Promise<void> {
  await db.schema.alterTable('billing_notifications', (t) => {
    t.dropColumn('recipient_email');
  });
  await db.schema.alterTable('subscriptions', (t) => {
    t.dropColumn('subscription_started_at');
    t.dropColumn('cancel_at');
  });
  await db.schema.alterTable('accounts', (t) => {
    t.dropColumn('suspended_by');
    t.dropColumn('suspended_reason');
    t.dropColumn('suspended');
  });
}
