import type { Knex } from 'knex';

/**
 * Daily visitors per published crux. One row per (crux, day, visitor token);
 * the token is an opaque per-day hash of the viewer (see
 * usage/cloudfront-logs.ts `visitorToken`) so log files that split a day can
 * be ingested independently and still count each visitor once. Nothing here
 * identifies a person or links two days. Rows are pruned after ~100 days.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE usage_visitor_days (
      author_id UUID NOT NULL,
      crux_id   UUID NOT NULL,
      day       DATE NOT NULL,
      visitor   TEXT NOT NULL,
      PRIMARY KEY (crux_id, day, visitor)
    );
    CREATE INDEX idx_usage_visitor_days_author_day ON usage_visitor_days (author_id, day);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS usage_visitor_days;`);
}
