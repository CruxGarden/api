import type { Knex } from 'knex';

/**
 * Per-crux secrets for Crux Functions (CRUX-FUNCTIONS-PLAN F1): set by the
 * author from the Share pane, encrypted at rest with the server's key,
 * readable by the crux's handlers as ctx.secrets.get(name) — never by a page,
 * never in an export, never in a log.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('crux_secrets', (t) => {
    t.uuid('crux_id').notNullable();
    t.text('name').notNullable();
    t.text('ciphertext').notNullable();
    t.text('iv').notNullable();
    t.text('tag').notNullable();
    t.timestamp('updated', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    t.primary(['crux_id', 'name']);
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('crux_secrets');
}
