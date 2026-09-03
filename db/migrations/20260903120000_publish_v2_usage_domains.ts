import type { Knex } from 'knex';

/**
 * Publish v2 (ADR 0011): usage metering per account and custom domains.
 * - usage_storage: exact published bytes per crux (written at publish)
 * - usage_daily:   bandwidth + requests per crux per UTC day (from CloudFront logs)
 * - usage_ingest:  log files already ingested (idempotency)
 * - custom_domains: hostname → crux, with verification + certificate state
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_storage (
      crux_id     UUID PRIMARY KEY REFERENCES cruxes(id) ON DELETE CASCADE,
      author_id   UUID NOT NULL REFERENCES authors(id),
      bytes       BIGINT NOT NULL DEFAULT 0,
      files       INTEGER NOT NULL DEFAULT 0,
      updated     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_usage_storage_author ON usage_storage (author_id);

    CREATE TABLE usage_daily (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id   UUID NOT NULL REFERENCES authors(id),
      crux_id     UUID NOT NULL,
      day         DATE NOT NULL,
      bytes       BIGINT NOT NULL DEFAULT 0,
      requests    BIGINT NOT NULL DEFAULT 0,
      updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (crux_id, day)
    );
    CREATE INDEX idx_usage_daily_author_day ON usage_daily (author_id, day);

    CREATE TABLE usage_ingest (
      key          TEXT PRIMARY KEY,
      bytes        BIGINT NOT NULL DEFAULT 0,
      requests     BIGINT NOT NULL DEFAULT 0,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE custom_domains (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      crux_id     UUID NOT NULL REFERENCES cruxes(id) ON DELETE CASCADE,
      author_id   UUID NOT NULL REFERENCES authors(id),
      hostname    TEXT NOT NULL UNIQUE,
      status      TEXT NOT NULL DEFAULT 'pending_dns',
      token       TEXT NOT NULL,
      tenant_id   TEXT,
      error       TEXT,
      created     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted     TIMESTAMPTZ
    );
    CREATE INDEX idx_custom_domains_crux ON custom_domains (crux_id) WHERE deleted IS NULL;
    CREATE INDEX idx_custom_domains_author ON custom_domains (author_id) WHERE deleted IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS custom_domains CASCADE;
    DROP TABLE IF EXISTS usage_ingest CASCADE;
    DROP TABLE IF EXISTS usage_daily CASCADE;
    DROP TABLE IF EXISTS usage_storage CASCADE;
  `);
}
