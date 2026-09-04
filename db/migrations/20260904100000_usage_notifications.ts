import type { Knex } from 'knex';

/** One email per (account, kind, billing period) — the dedupe ledger for usage notices. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_notifications (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,
      period_start DATE NOT NULL,
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, kind, period_start)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS usage_notifications CASCADE;`);
}
