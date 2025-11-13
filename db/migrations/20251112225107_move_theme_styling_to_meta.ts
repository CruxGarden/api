import type { Knex } from 'knex';

/**
 * Migration: Move theme styling to meta field
 *
 * Consolidates all theme styling data into the meta JSONB field,
 * matching the structure sent by ThemeBuilder.
 *
 * Drops redundant columns:
 * - primary_color, secondary_color, tertiary_color, quaternary_color
 * - border_radius, border_color, border_width
 * - background_color, panel_color, text_color
 * - font, mode
 *
 * Adds:
 * - system (boolean) - mark system-provided themes
 *
 * Final schema:
 * - id, author_id, home_id, title, key, description, type, kind, system
 * - meta (JSONB containing all styling)
 * - created, updated, deleted
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('themes', (table) => {
    // Drop all styling columns - data should be in meta field
    table.dropColumn('primary_color');
    table.dropColumn('secondary_color');
    table.dropColumn('tertiary_color');
    table.dropColumn('quaternary_color');
    table.dropColumn('border_radius');
    table.dropColumn('border_color');
    table.dropColumn('border_width');
    table.dropColumn('background_color');
    table.dropColumn('panel_color');
    table.dropColumn('text_color');
    table.dropColumn('font');
    table.dropColumn('mode');

    // Add system flag for built-in themes
    table.boolean('system').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('themes', (table) => {
    // Remove system flag
    table.dropColumn('system');

    // Restore columns (without constraints for simplicity)
    table.string('primary_color', 7);
    table.string('secondary_color', 7);
    table.string('tertiary_color', 7);
    table.string('quaternary_color', 7);
    table.string('border_radius', 10);
    table.string('border_color');
    table.string('border_width');
    table.text('background_color');
    table.text('panel_color');
    table.text('text_color');
    table.string('font', 100);
    table.string('mode', 5);
  });
}

