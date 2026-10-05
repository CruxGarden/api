import type { Knex } from 'knex';

/**
 * Reports of published creations and operator takedowns (hosted moderation
 * state; never Garden content). Neither table references `cruxes`: unpublish
 * hard-deletes the crux row, and both records must outlive it.
 */
export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('reports', (t) => {
    t.uuid('id').primary();
    t.uuid('crux_id').notNullable();
    // Snapshots for the operator once the crux row is gone.
    t.uuid('author_id');
    t.text('crux_slug');
    t.text('crux_title');
    t.text('reason').notNullable();
    t.text('details');
    t.text('reporter_email');
    // Salted hash, never the address itself.
    t.text('reporter_ip_hash');
    t.text('status').notNullable().defaultTo('open');
    t.text('resolution_note');
    t.uuid('resolved_by');
    t.timestamp('resolved');
    t.timestamp('created').notNullable().defaultTo(db.fn.now());
    t.timestamp('updated').notNullable().defaultTo(db.fn.now());
    t.timestamp('deleted');
    t.index(['status', 'created']);
    t.index(['crux_id']);
  });
  await db.raw(
    `ALTER TABLE reports ADD CONSTRAINT reports_reason_check CHECK (reason IN ('illegal', 'harmful', 'spam', 'copyright', 'other'))`,
  );
  await db.raw(
    `ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('open', 'resolved', 'dismissed'))`,
  );

  await db.schema.createTable('takedowns', (t) => {
    t.uuid('id').primary();
    t.uuid('crux_id').notNullable();
    t.uuid('author_id');
    t.text('reason').notNullable();
    t.uuid('report_id');
    t.uuid('created_by').notNullable();
    // Lifting keeps the row as the audit trail; active = lifted IS NULL.
    t.timestamp('lifted');
    t.uuid('lifted_by');
    t.timestamp('created').notNullable().defaultTo(db.fn.now());
    t.timestamp('updated').notNullable().defaultTo(db.fn.now());
    t.timestamp('deleted');
  });
  await db.raw(
    'CREATE UNIQUE INDEX takedowns_active_crux ON takedowns (crux_id) WHERE lifted IS NULL AND deleted IS NULL',
  );
}

export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable('takedowns');
  await db.schema.dropTable('reports');
}
