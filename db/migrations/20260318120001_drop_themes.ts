import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE cruxes DROP COLUMN IF EXISTS theme_id;
    ALTER TABLE paths DROP COLUMN IF EXISTS theme_id;
    DROP TABLE IF EXISTS themes CASCADE;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS themes (
      id uuid PRIMARY KEY,
      title varchar NOT NULL,
      description text,
      author_id uuid REFERENCES authors(id) ON DELETE SET NULL,
      home_id uuid NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
      system boolean NOT NULL DEFAULT false,
      meta jsonb NOT NULL,
      type varchar,
      kind varchar,
      created timestamp with time zone NOT NULL DEFAULT now(),
      updated timestamp with time zone NOT NULL DEFAULT now(),
      deleted timestamp with time zone,
      CONSTRAINT themes_title_unique UNIQUE (title)
    );

    ALTER TABLE cruxes ADD COLUMN theme_id uuid REFERENCES themes(id) ON DELETE SET NULL;
    ALTER TABLE paths ADD COLUMN theme_id uuid REFERENCES themes(id) ON DELETE SET NULL;
  `);
}
