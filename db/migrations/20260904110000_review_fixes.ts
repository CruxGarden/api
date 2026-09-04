import type { Knex } from 'knex';

/**
 * Code-review fixes (2026-09-04):
 * - subscriptions.past_due_since: the grace clock starts once, on the transition
 *   to past_due, instead of resetting on every webhook write.
 * - usage_daily(day): reconciliation sums a whole day across authors.
 * - custom_domains: uniqueness only among live rows (issuing/active) so a stale
 *   pending claim can no longer squat a hostname; pending claims expire.
 * - usage_unattributed: bytes CloudFront served for hosts we could not attribute,
 *   so reconciliation compares like with like.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);

    ALTER TABLE custom_domains DROP CONSTRAINT IF EXISTS custom_domains_hostname_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_domains_live_hostname
      ON custom_domains (hostname)
      WHERE deleted IS NULL AND status IN ('issuing', 'active');
    CREATE INDEX IF NOT EXISTS idx_custom_domains_hostname ON custom_domains (hostname) WHERE deleted IS NULL;

    CREATE TABLE IF NOT EXISTS usage_unattributed (
      day       DATE PRIMARY KEY,
      bytes     BIGINT NOT NULL DEFAULT 0,
      requests  BIGINT NOT NULL DEFAULT 0,
      updated   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS usage_unattributed;
    DROP INDEX IF EXISTS uq_custom_domains_live_hostname;
    DROP INDEX IF EXISTS idx_custom_domains_hostname;
    ALTER TABLE custom_domains ADD CONSTRAINT custom_domains_hostname_key UNIQUE (hostname);
    DROP INDEX IF EXISTS idx_usage_daily_day;
    ALTER TABLE subscriptions DROP COLUMN IF EXISTS past_due_since;
  `);
}
