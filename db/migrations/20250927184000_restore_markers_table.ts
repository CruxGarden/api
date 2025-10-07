import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table markers (
      id uuid primary key,
      path_id uuid not null references paths(id) on delete cascade on update cascade,
      crux_id uuid not null references cruxes(id) on delete cascade on update cascade,

      "order" integer not null,
      note text,

      author_id uuid not null references authors(id) on delete cascade on update cascade,

      created timestamp with time zone not null default now(),
      updated timestamp with time zone not null default now(),
      deleted timestamp with time zone null,

      constraint unique_path_order unique (path_id, "order"),
      constraint check_order_positive check ("order" >= 0)
    );

    create index idx_markers_path_id on markers (path_id);
    create index idx_markers_crux_id on markers (crux_id);
    create index idx_markers_author_id on markers (author_id);
    create index idx_markers_path_order on markers (path_id, "order");
    create index idx_markers_order on markers ("order");
    create index idx_markers_path_crux on markers (path_id, crux_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists markers cascade;
  `);
}