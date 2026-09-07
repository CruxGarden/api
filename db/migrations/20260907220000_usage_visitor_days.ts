import type { Knex } from 'knex';

/**
 * Visitors per published crux. Tokens: one row per (crux, day, visitor
 * token) — the token is an opaque per-day hash of the viewer (see
 * usage/cloudfront-logs.ts `visitorToken`) so log files that split a day can
 * be ingested independently and still count each visitor once. Nothing here
 * identifies a person or links two days, and rows are pruned after ~100 days.
 * What is read is the counter: usage_daily.visitors, added to as new tokens
 * land, kept for good — the crux's cumulative visitor count.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_visitor_days (
      crux_id UUID NOT NULL,
      day     DATE NOT NULL,
      visitor TEXT NOT NULL,
      PRIMARY KEY (crux_id, day, visitor)
    );
    ALTER TABLE usage_daily ADD COLUMN visitors BIGINT NOT NULL DEFAULT 0;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE usage_daily DROP COLUMN IF EXISTS visitors;
    DROP TABLE IF EXISTS usage_visitor_days;
  `);
}
