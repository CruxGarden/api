import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table accounts (
      id uuid primary key,
      email varchar not null,
      role varchar not null,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint accounts_email_key unique (email),
      constraint check_accounts_role check (role in ('keeper', 'admin', 'author'))
    );

    create table authors (
      id uuid primary key,
      key text not null,
      account_id uuid not null references accounts(id) on delete cascade on update cascade,
      username varchar not null,
      display_name text not null,
      bio text,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint authors_key_unique unique (key),
      constraint authors_username_key unique (username)
    );

    create table themes (
      id uuid primary key,
      name varchar not null,
      key text not null,
      description text,

      primary_color varchar(7) not null,
      secondary_color varchar(7) not null,
      tertiary_color varchar(7) not null,
      quaternary_color varchar(7) not null,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint themes_key_unique unique (key),
      constraint themes_name_unique unique (name),
      constraint check_primary_color_format check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
      constraint check_secondary_color_format check (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
      constraint check_tertiary_color_format check (tertiary_color ~ '^#[0-9A-Fa-f]{6}$'),
      constraint check_quaternary_color_format check (quaternary_color ~ '^#[0-9A-Fa-f]{6}$')
    );

    create table cruxes (
      id uuid primary key,
      key text not null,
      slug text not null,

      title text,
      data text not null,
      type varchar not null default 'text',

      theme_id uuid references themes(id) on delete set null on update cascade,
      author_id uuid not null references authors(id) on delete cascade on update cascade,

      created timestamp with time zone not null default now(),
      merged timestamp with time zone,
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      status text not null default 'living',
      visibility text not null default 'unlisted',

      constraint cruxes_key_unique unique (key),
      constraint cruxes_slug_key unique (slug),
      constraint check_cruxes_status check (status in ('living', 'frozen')),
      constraint check_cruxes_visibility check (visibility in ('public', 'private', 'unlisted'))
    );

    create table paths (
      id uuid primary key,
      key text not null,
      slug text not null,

      type varchar not null default 'living',
      head uuid references cruxes(id) on delete set null on update cascade,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint paths_key_unique unique (key),
      constraint paths_slug_unique unique (slug),
      constraint paths_type check (type in ('living', 'frozen'))
    );

    create table dimensions (
      id uuid primary key,
      source_id uuid not null references cruxes(id) on delete cascade on update cascade,
      target_id uuid not null references cruxes(id) on delete cascade on update cascade,

      type text not null,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint check_dimensions_type check (type in ('gate', 'growth', 'garden', 'graft')),
      constraint check_dimensions_no_self_reference check (source_id != target_id),
      constraint unique_source_target_type unique (source_id, target_id, type)
    );

    create table markers (
      id uuid primary key,
      path_id uuid not null references paths(id) on delete cascade on update cascade,
      crux_id uuid not null references cruxes(id) on delete cascade on update cascade,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint unique_path_crux unique (path_id, crux_id)
    );

    create table tags (
      id uuid primary key,
      crux_id uuid not null references cruxes(id) on delete cascade on update cascade,
      label text not null,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint unique_tag unique (crux_id, label),
      constraint tags_lowercase_check check (label = lower(label))
    );

    create index idx_accounts_email on accounts (email);

    create index idx_authors_account_id on authors (account_id);
    create index idx_authors_username on authors (username);
    create index idx_authors_key on authors (key);

    create index idx_themes_key on themes (key);
    create index idx_themes_name on themes (name);

    create index idx_cruxes_author_id on cruxes (author_id);
    create index idx_cruxes_slug on cruxes (slug);
    create index idx_cruxes_key on cruxes (key);
    create index idx_cruxes_visibility on cruxes (visibility);
    create index idx_cruxes_created on cruxes (created);

    create index idx_paths_key on paths (key);
    create index idx_paths_slug on paths (slug);

    create index idx_dimension_source_type on dimensions (source_id, type);
    create index idx_dimension_target_type on dimensions (target_id, type);

    create index idx_markers_path on markers (path_id);
    create index idx_markers_crux on markers (crux_id);

    create index idx_tags_crux_id on tags (crux_id);
    create index idx_tags_label on tags (label);
  `);
}


export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists tags cascade;
    drop table if exists markers cascade;
    drop table if exists dimensions cascade;
    drop table if exists paths cascade;
    drop table if exists cruxes cascade;
    drop table if exists themes cascade;
    drop table if exists authors cascade;
    drop table if exists accounts cascade;
  `);
}

