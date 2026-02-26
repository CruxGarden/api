import type { Knex } from "knex";

const TABLES = [
  'accounts',
  'attachments',
  'authors',
  'cruxes',
  'dimensions',
  'homes',
  'markers',
  'paths',
  'tags',
  'themes',
];

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    const hasKey = await knex.schema.hasColumn(table, 'key');
    if (hasKey) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn('key');
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    const hasKey = await knex.schema.hasColumn(table, 'key');
    if (!hasKey) {
      await knex.schema.alterTable(table, (t) => {
        t.string('key', 255).nullable();
      });
    }
  }
}
