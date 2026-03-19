import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE store (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      crux_id     UUID NOT NULL REFERENCES cruxes(id) ON DELETE CASCADE,
      author_id   UUID NOT NULL REFERENCES authors(id),
      visitor_id  UUID REFERENCES authors(id),
      key         TEXT NOT NULL,
      value       JSONB NOT NULL,
      mode        TEXT NOT NULL DEFAULT 'protected',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_store_public
      ON store (crux_id, key)
      WHERE visitor_id IS NULL;

    CREATE UNIQUE INDEX idx_store_protected
      ON store (crux_id, visitor_id, key)
      WHERE visitor_id IS NOT NULL;

    CREATE INDEX idx_store_crux    ON store (crux_id);
    CREATE INDEX idx_store_author  ON store (author_id);
    CREATE INDEX idx_store_visitor ON store (visitor_id) WHERE visitor_id IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS store CASCADE;');
}
