import type { Knex } from 'knex';

/**
 * Billing safeguards (ADR 0011 amendment 3):
 * - usage_reconciliation: per UTC day, our metered publish bytes vs CloudFront's own
 *   BytesDownloaded for the distribution — a gap means lost log files.
 * - usage_periods: one finalized record per author per billing period, written after
 *   the grace window closes. The subscription system bills from these, never from
 *   the live tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_reconciliation (
      day            DATE PRIMARY KEY,
      metered_bytes  BIGINT NOT NULL DEFAULT 0,
      edge_bytes     BIGINT,
      gap_pct        NUMERIC(8,3),
      status         TEXT NOT NULL,
      checked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE usage_periods (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id               UUID NOT NULL REFERENCES authors(id),
      account_id              UUID,
      period_start            DATE NOT NULL,
      period_end              DATE NOT NULL,
      plan_id                 TEXT NOT NULL,
      storage_limit           BIGINT NOT NULL,
      bandwidth_limit         BIGINT NOT NULL,
      storage_bytes           BIGINT NOT NULL DEFAULT 0,
      publish_storage_bytes   BIGINT NOT NULL DEFAULT 0,
      sync_storage_bytes      BIGINT NOT NULL DEFAULT 0,
      bandwidth_bytes         BIGINT NOT NULL DEFAULT 0,
      publish_bandwidth_bytes BIGINT NOT NULL DEFAULT 0,
      sync_transfer_bytes     BIGINT NOT NULL DEFAULT 0,
      requests                BIGINT NOT NULL DEFAULT 0,
      over_storage            BOOLEAN NOT NULL DEFAULT false,
      over_bandwidth          BOOLEAN NOT NULL DEFAULT false,
      reconciliation_status   TEXT,
      finalized_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (author_id, period_start)
    );
    CREATE INDEX idx_usage_periods_author ON usage_periods (author_id, period_start DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS usage_periods CASCADE;
    DROP TABLE IF EXISTS usage_reconciliation CASCADE;
  `);
}
