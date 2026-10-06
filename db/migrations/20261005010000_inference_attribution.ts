import type { Knex } from 'knex';

/**
 * Included inference (ADR 0082): which Crux a request served and whether it was
 * chat or an image, the honest settlement statuses, and the operator's
 * lower-only adjustment trail. `crux_id` is an attribution label sent by the
 * desktop, never an authorization input, so it has no foreign key: unpublish
 * and local-only cruxes must not break the ledger.
 */
export async function up(db: Knex): Promise<void> {
  await db.schema.alterTable('inference_requests', (t) => {
    t.uuid('crux_id').nullable();
    t.text('kind').notNullable().defaultTo('chat');
    // Lower-only operator adjustment: who, when, why, and the charge before it.
    t.timestamp('adjusted', { useTz: true }).nullable();
    t.uuid('adjusted_by').nullable();
    t.text('adjustment_reason').nullable();
    t.bigInteger('adjusted_from_microdollars').nullable();
  });
  await db.raw(
    `UPDATE inference_requests SET kind = 'image' WHERE model LIKE 'gpt-image%'`,
  );
  await db.raw(
    `ALTER TABLE inference_requests ADD CONSTRAINT inference_requests_kind_check CHECK (kind IN ('chat', 'image'))`,
  );
  await db.raw(
    `ALTER TABLE inference_requests ADD CONSTRAINT inference_requests_status_check CHECK (status IN ('reserved', 'complete', 'interrupted', 'estimated', 'uncertain', 'rejected', 'abandoned'))`,
  );
  // The stuck-reservation sweeper reads only live reservations.
  await db.raw(
    `CREATE INDEX inference_requests_reserved ON inference_requests (created) WHERE status = 'reserved' AND deleted IS NULL`,
  );
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP INDEX IF EXISTS inference_requests_reserved');
  await db.raw(
    'ALTER TABLE inference_requests DROP CONSTRAINT IF EXISTS inference_requests_status_check',
  );
  await db.raw(
    'ALTER TABLE inference_requests DROP CONSTRAINT IF EXISTS inference_requests_kind_check',
  );
  await db.schema.alterTable('inference_requests', (t) => {
    t.dropColumn('adjusted_from_microdollars');
    t.dropColumn('adjustment_reason');
    t.dropColumn('adjusted_by');
    t.dropColumn('adjusted');
    t.dropColumn('kind');
    t.dropColumn('crux_id');
  });
}
