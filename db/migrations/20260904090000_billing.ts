import type { Knex } from 'knex';

/**
 * Subscriptions (ADR 0012): one row per account, written only by provider
 * webhooks (and an authenticated re-sync). billing_events stores every
 * webhook once by provider event id — the idempotency key.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE subscriptions (
      account_id            UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      provider              TEXT NOT NULL DEFAULT 'stripe',
      customer_id           TEXT,
      subscription_id       TEXT UNIQUE,
      plan_id               TEXT NOT NULL DEFAULT 'free',
      price_id              TEXT,
      interval              TEXT,
      status                TEXT NOT NULL DEFAULT 'none',
      current_period_start  TIMESTAMPTZ,
      current_period_end    TIMESTAMPTZ,
      cancel_at_period_end  BOOLEAN NOT NULL DEFAULT false,
      trial_end             TIMESTAMPTZ,
      updated               TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_subscriptions_customer ON subscriptions (customer_id);

    CREATE TABLE billing_events (
      id           TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      type         TEXT NOT NULL,
      account_id   UUID,
      payload      JSONB,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_billing_events_account ON billing_events (account_id, received_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS billing_events CASCADE;
    DROP TABLE IF EXISTS subscriptions CASCADE;
  `);
}
