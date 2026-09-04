import type { Knex } from 'knex';

/** Crux Store usage: reads/writes per crux per UTC day (bytes at rest are measured live from `store`). */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_store_daily (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id   UUID NOT NULL REFERENCES authors(id),
      crux_id     UUID NOT NULL,
      day         DATE NOT NULL,
      reads       BIGINT NOT NULL DEFAULT 0,
      writes      BIGINT NOT NULL DEFAULT 0,
      updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (crux_id, day)
    );
    CREATE INDEX idx_usage_store_daily_author_day ON usage_store_daily (author_id, day);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS usage_store_daily CASCADE;`);
}
