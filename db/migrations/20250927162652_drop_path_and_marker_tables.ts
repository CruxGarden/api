import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  return knex.raw(`
    drop table if exists markers cascade;
    drop table if exists paths cascade;
  `);
}

export async function down(knex: Knex): Promise<void> {
    return knex.raw(`
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

    create table markers (
      id uuid primary key,
      path_id uuid not null references paths(id) on delete cascade on update cascade,
      crux_id uuid not null references cruxes(id) on delete cascade on update cascade,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint unique_path_crux unique (path_id, crux_id)
    );

    create index idx_paths_key on paths (key);
    create index idx_paths_slug on paths (slug);

    create index idx_markers_path on markers (path_id);
    create index idx_markers_crux on markers (crux_id);
  `);
}

