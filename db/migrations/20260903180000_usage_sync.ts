import type { Knex } from 'knex';

/**
 * Sync usage, tied to the account (ADR 0011 amendment): garden backups and
 * synced cruxes count toward the same storage and transfer budgets as publishing.
 * - usage_sync_objects: exact bytes per synced object (garden, or one crux)
 * - usage_sync_daily:   bytes pushed / pulled per account per UTC day
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_sync_objects (
      account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      object_id   TEXT NOT NULL,
      bytes       BIGINT NOT NULL DEFAULT 0,
      title       TEXT,
      updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, kind, object_id)
    );

    CREATE TABLE usage_sync_daily (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      day         DATE NOT NULL,
      bytes_up    BIGINT NOT NULL DEFAULT 0,
      bytes_down  BIGINT NOT NULL DEFAULT 0,
      uploads     INTEGER NOT NULL DEFAULT 0,
      downloads   INTEGER NOT NULL DEFAULT 0,
      updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, day)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS usage_sync_daily CASCADE;
    DROP TABLE IF EXISTS usage_sync_objects CASCADE;
  `);
}
