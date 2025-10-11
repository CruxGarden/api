import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const tables = [
    'accounts',
    'cruxes',
    'dimensions',
    'paths',
    'tags',
    'themes',
    'attachments'
  ];

  for (const table of tables) {
    await knex.schema.alterTable(table, (t) => {
      t.uuid('home_id').notNullable();
      t.foreign('home_id').references('id').inTable('homes').onDelete('CASCADE').onUpdate('CASCADE');
      t.index('home_id', `idx_${table}_home_id`);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const tables = [
    'accounts',
    'cruxes',
    'dimensions',
    'paths',
    'tags',
    'themes',
    'attachments'
  ];

  for (const table of tables) {
    await knex.schema.alterTable(table, (t) => {
      t.dropIndex('home_id', `idx_${table}_home_id`);
      t.dropForeign('home_id');
      t.dropColumn('home_id');
    });
  }
}
