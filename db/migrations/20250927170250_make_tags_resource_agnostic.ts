import type { Knex } from 'knex';

const TAG_CRUX_FOREIGN_KEY_NAME = 'tags_crux_id_fkey';

export async function up(knex: Knex): Promise<void> {
  // Remove crux-specific foreign key and column
  await knex.schema.alterTable('tags', (table) => {
    table.dropForeign('crux_id', TAG_CRUX_FOREIGN_KEY_NAME); 
    table.dropColumn('crux_id');

    table.text('resource_type').notNullable();
    table.uuid('resource_id').notNullable();
  });

  await knex.schema.raw(`
    ALTER TABLE tags
    DROP CONSTRAINT IF EXISTS unique_tag,
    DROP CONSTRAINT IF EXISTS tags_lowercase_check;
  `);

  // Add unique constraint and lowercase check
  await knex.schema.raw(`
    ALTER TABLE tags
    ADD CONSTRAINT unique_tag UNIQUE (resource_type, resource_id, label),
    ADD CONSTRAINT tags_lowercase_check CHECK (label = lower(label));
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Remove the polymorphic fields and constraints
  await knex.schema.alterTable('tags', (table) => {
    table.dropColumn('resource_type');
    table.dropColumn('resource_id');
  });

  await knex.schema.raw(`
    ALTER TABLE tags
    DROP CONSTRAINT IF EXISTS unique_tag,
    DROP CONSTRAINT IF EXISTS tags_lowercase_check;
  `);

  // Restore crux_id and its constraints
  await knex.schema.alterTable('tags', (table) => {
    table.uuid('crux_id').notNullable();
  });

  await knex.schema.raw(`
    ALTER TABLE tags
    ADD CONSTRAINT unique_tag UNIQUE (crux_id, label),
    ADD CONSTRAINT tags_lowercase_check CHECK (label = lower(label)),
    ADD CONSTRAINT tags_crux_fk FOREIGN KEY (crux_id) REFERENCES cruxes(id)
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  `);
};
