import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // === HOMES ===
  await knex.raw(`
    create table if not exists homes (
      id uuid primary key,
      name varchar not null,
      description text,
      "primary" boolean not null default false,
      type varchar not null,
      kind varchar not null,
      meta jsonb,
      created timestamp with time zone not null default current_timestamp,
      updated timestamp with time zone not null default current_timestamp,
      deleted timestamp with time zone
    );

    create index if not exists idx_homes_type on homes (type);
    create index if not exists idx_homes_kind on homes (kind);
    create index if not exists idx_homes_created on homes (created);
    create unique index if not exists idx_homes_unique_primary on homes ("primary")
      where ("primary" = true and deleted is null);
  `);

  // === ACCOUNTS ===
  await knex.raw(`
    create table if not exists accounts (
      id uuid primary key,
      email varchar not null,
      role varchar not null,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint accounts_email_key unique (email)
    );

    create index if not exists idx_accounts_email on accounts (email);
    create index if not exists idx_accounts_home_id on accounts (home_id);
  `);

  // === AUTHORS ===
  await knex.raw(`
    create table if not exists authors (
      id uuid primary key,
      account_id uuid not null references accounts(id) on delete cascade on update cascade,
      username varchar not null,
      display_name varchar not null,
      bio text,
      home_id uuid references homes(id) on delete set null on update cascade,
      type varchar,
      kind varchar,
      meta jsonb,
      root_id uuid,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint authors_username_key unique (username)
    );

    create index if not exists idx_authors_account_id on authors (account_id);
    create index if not exists idx_authors_username on authors (username);
    create index if not exists idx_authors_home_id on authors (home_id);
    create index if not exists idx_authors_root_id on authors (root_id);
  `);

  // === THEMES ===
  await knex.raw(`
    create table if not exists themes (
      id uuid primary key,
      title varchar not null,
      description text,
      author_id uuid references authors(id) on delete set null on update cascade,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      system boolean not null default false,
      meta jsonb not null,
      type varchar,
      kind varchar,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint themes_title_unique unique (title)
    );

    create index if not exists idx_themes_title on themes (title);
    create index if not exists idx_themes_author_id on themes (author_id);
    create index if not exists idx_themes_home_id on themes (home_id);
  `);

  // === CRUXES ===
  await knex.raw(`
    create table if not exists cruxes (
      id uuid primary key,
      slug varchar not null,
      title text,
      data text not null,
      type varchar not null,
      kind varchar,
      description text,
      meta jsonb,
      discoverable boolean default false,
      theme_id uuid references themes(id) on delete set null on update cascade,
      author_id uuid not null references authors(id) on delete cascade on update cascade,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      status varchar not null,
      visibility varchar not null,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint cruxes_author_slug_unique unique (author_id, slug)
    );

    create index if not exists idx_cruxes_author_id on cruxes (author_id);
    create index if not exists idx_cruxes_slug on cruxes (slug);
    create index if not exists idx_cruxes_visibility on cruxes (visibility);
    create index if not exists idx_cruxes_created on cruxes (created);
    create index if not exists idx_cruxes_home_id on cruxes (home_id);
  `);

  // Add root_id FK now that cruxes table exists
  await knex.raw(`
    do $$ begin
      alter table authors add constraint authors_root_id_foreign
        foreign key (root_id) references cruxes(id) on delete set null on update cascade;
    exception when duplicate_object then null;
    end $$;
  `);

  // === DIMENSIONS ===
  await knex.raw(`
    create table if not exists dimensions (
      id uuid primary key,
      source_id uuid not null references cruxes(id) on delete cascade on update cascade,
      target_id uuid not null references cruxes(id) on delete cascade on update cascade,
      type varchar not null,
      weight integer,
      note text,
      author_id uuid references authors(id) on delete set null on update cascade,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      kind varchar,
      meta jsonb,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint check_dimensions_no_self_reference check (source_id != target_id)
    );

    create index if not exists idx_dimension_source_type on dimensions (source_id, type);
    create index if not exists idx_dimension_target_type on dimensions (target_id, type);
    create index if not exists idx_dimensions_author_id on dimensions (author_id);
    create index if not exists idx_dimensions_home_id on dimensions (home_id);
    create index if not exists dimensions_weight_index on dimensions (weight);
  `);

  // === PATHS ===
  await knex.raw(`
    create table if not exists paths (
      id uuid primary key,
      slug varchar not null,
      title text,
      description text,
      type varchar not null,
      kind varchar not null,
      visibility varchar not null default 'unlisted',
      author_id uuid not null references authors(id) on delete cascade on update cascade,
      theme_id uuid references themes(id) on delete set null on update cascade,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      meta jsonb,
      entry uuid,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint paths_slug_unique unique (slug)
    );

    create index if not exists idx_paths_slug on paths (slug);
    create index if not exists idx_paths_author_id on paths (author_id);
    create index if not exists idx_paths_type on paths (type);
    create index if not exists idx_paths_visibility on paths (visibility);
    create index if not exists idx_paths_created on paths (created);
    create index if not exists idx_paths_home_id on paths (home_id);
  `);

  // === MARKERS ===
  await knex.raw(`
    create table if not exists markers (
      id uuid primary key,
      path_id uuid not null references paths(id) on delete cascade on update cascade,
      crux_id uuid not null references cruxes(id) on delete cascade on update cascade,
      "order" integer not null,
      note text,
      author_id uuid not null references authors(id) on delete cascade on update cascade,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint check_order_positive check ("order" >= 0),
      constraint unique_path_order unique (path_id, "order")
    );

    create index if not exists idx_markers_path_id on markers (path_id);
    create index if not exists idx_markers_crux_id on markers (crux_id);
    create index if not exists idx_markers_path_crux on markers (path_id, crux_id);
    create index if not exists idx_markers_order on markers ("order");
    create index if not exists idx_markers_path_order on markers (path_id, "order");
    create index if not exists idx_markers_author_id on markers (author_id);
  `);

  // Add entry FK now that markers table exists
  await knex.raw(`
    do $$ begin
      alter table paths add constraint paths_entry_foreign
        foreign key (entry) references markers(id) on delete set null on update cascade;
    exception when duplicate_object then null;
    end $$;
  `);

  // === TAGS ===
  await knex.raw(`
    create table if not exists tags (
      id uuid primary key,
      label varchar not null,
      resource_type varchar not null,
      resource_id uuid not null,
      author_id uuid references authors(id) on delete set null on update cascade,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      system boolean not null default false,
      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone,
      constraint unique_tag unique (resource_type, resource_id, label)
    );

    create index if not exists idx_tags_label on tags (label);
    create index if not exists idx_tags_resource_id on tags (resource_id);
    create index if not exists idx_tags_resource_type on tags (resource_type);
    create index if not exists idx_tags_author_id on tags (author_id);
    create index if not exists idx_tags_home_id on tags (home_id);
    create index if not exists idx_tags_system on tags (system);
  `);

  // === ARTIFACTS ===
  await knex.raw(`
    create table if not exists artifacts (
      id uuid primary key,
      type varchar not null,
      kind varchar not null,
      meta jsonb,
      resource_id uuid not null,
      resource_type varchar not null,
      author_id uuid not null references authors(id) on delete cascade on update cascade,
      home_id uuid not null references homes(id) on delete cascade on update cascade,
      encoding varchar not null,
      mime_type varchar not null,
      filename varchar not null,
      size bigint not null,
      created timestamp with time zone not null default current_timestamp,
      updated timestamp with time zone not null default current_timestamp,
      deleted timestamp with time zone
    );

    create index if not exists idx_attachments_resource on artifacts (resource_id, resource_type);
    create index if not exists idx_attachments_type on artifacts (type);
    create index if not exists idx_attachments_kind on artifacts (kind);
    create index if not exists idx_attachments_author_id on artifacts (author_id);
    create index if not exists idx_attachments_home_id on artifacts (home_id);
    create index if not exists idx_attachments_created on artifacts (created);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists artifacts cascade;
    drop table if exists tags cascade;
    drop table if exists markers cascade;
    drop table if exists paths cascade;
    drop table if exists dimensions cascade;
    drop table if exists cruxes cascade;
    drop table if exists themes cascade;
    drop table if exists authors cascade;
    drop table if exists accounts cascade;
    drop table if exists homes cascade;
  `);
}
