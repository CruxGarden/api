import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table paths (
      id uuid primary key,
      key text not null,
      slug text not null,
      title text,
      description text,

      type varchar not null default 'living',
      visibility varchar not null default 'unlisted',

      author_id uuid not null references authors(id) on delete cascade on update cascade,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint paths_key_unique unique (key),
      constraint paths_slug_unique unique (slug),
      constraint check_paths_type check (type in ('living', 'frozen')),
      constraint check_paths_visibility check (visibility in ('public', 'private', 'unlisted'))
    );

    create index idx_paths_key on paths (key);
    create index idx_paths_slug on paths (slug);
    create index idx_paths_author_id on paths (author_id);
    create index idx_paths_visibility on paths (visibility);
    create index idx_paths_type on paths (type);
    create index idx_paths_created on paths (created);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists paths cascade;
  `);
}