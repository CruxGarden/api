import type { Knex } from 'knex';


export async function up(knex: Knex): Promise<void> {
  // Remove existing color format constraints
  await knex.raw(`
    ALTER TABLE themes
    DROP CONSTRAINT IF EXISTS check_primary_color_format,
    DROP CONSTRAINT IF EXISTS check_secondary_color_format,
    DROP CONSTRAINT IF EXISTS check_tertiary_color_format,
    DROP CONSTRAINT IF EXISTS check_quaternary_color_format
  `);

  // Add new styling columns
  await knex.schema.alterTable('themes', (table) => {
    table.string('border_radius', 10);
    table.text('background_color');
    table.text('panel_color');
    table.text('text_color');
    table.string('font', 100);
    table.string('mode', 5);
  });
}


export async function down(knex: Knex): Promise<void> {
  // Remove the added columns
  await knex.schema.alterTable('themes', (table) => {
    table.dropColumn('border_radius');
    table.dropColumn('background_color');
    table.dropColumn('panel_color');
    table.dropColumn('text_color');
    table.dropColumn('font');
    table.dropColumn('mode');
  });

  // Re-add the color format constraints
  await knex.raw(`
    ALTER TABLE themes
    ADD CONSTRAINT check_primary_color_format CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT check_secondary_color_format CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT check_tertiary_color_format CHECK (tertiary_color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT check_quaternary_color_format CHECK (quaternary_color ~ '^#[0-9A-Fa-f]{6}$')
  `);
}

