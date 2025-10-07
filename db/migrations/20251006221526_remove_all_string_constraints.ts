import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- Remove CHECK constraints from accounts table
    alter table accounts drop constraint if exists check_accounts_role;

    -- Remove CHECK constraints from cruxes table
    alter table cruxes drop constraint if exists check_cruxes_status;
    alter table cruxes drop constraint if exists check_cruxes_visibility;

    -- Remove CHECK constraints from paths table
    alter table paths drop constraint if exists check_paths_type;
    alter table paths drop constraint if exists check_paths_visibility;
    alter table paths drop constraint if exists check_paths_kind;

    -- Remove CHECK constraints from tags table
    alter table tags drop constraint if exists tags_lowercase_check;

    -- Remove CHECK constraints from themes table
    alter table themes drop constraint if exists check_primary_color_format;
    alter table themes drop constraint if exists check_secondary_color_format;
    alter table themes drop constraint if exists check_tertiary_color_format;
    alter table themes drop constraint if exists check_quaternary_color_format;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    -- Restore CHECK constraints to accounts table
    alter table accounts add constraint check_accounts_role
      check (role in ('keeper', 'admin', 'author'));

    -- Restore CHECK constraints to cruxes table
    alter table cruxes add constraint check_cruxes_status
      check (status in ('living', 'frozen'));
    alter table cruxes add constraint check_cruxes_visibility
      check (visibility in ('public', 'private', 'unlisted'));

    -- Restore CHECK constraints to paths table
    alter table paths add constraint check_paths_type
      check (type in ('living', 'frozen'));
    alter table paths add constraint check_paths_visibility
      check (visibility in ('public', 'private', 'unlisted'));
    alter table paths add constraint check_paths_kind
      check (kind in ('guide', 'wander'));

    -- Restore CHECK constraints to tags table
    alter table tags add constraint tags_lowercase_check
      check (label = lower(label));

    -- Restore CHECK constraints to themes table
    alter table themes add constraint check_primary_color_format
      check (primary_color ~ '^#[0-9A-Fa-f]{6}$');
    alter table themes add constraint check_secondary_color_format
      check (secondary_color ~ '^#[0-9A-Fa-f]{6}$');
    alter table themes add constraint check_tertiary_color_format
      check (tertiary_color ~ '^#[0-9A-Fa-f]{6}$');
    alter table themes add constraint check_quaternary_color_format
      check (quaternary_color ~ '^#[0-9A-Fa-f]{6}$');
  `);
}

