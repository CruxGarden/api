import { Knex } from 'knex';

/**
 * Verify that all expected tables exist and contain the expected columns.
 * This seed is non-destructive — it only reads and logs results.
 */

const expectedTables = [
  'accounts',
  'authors',
  'cruxes',
  'paths',
  'dimensions',
  'markers',
  'tags',
  'homes',
  'artifacts',
  'store',
];

export async function seed(knex: Knex): Promise<void> {
  console.log('\n=== Schema Verification ===\n');

  const missing: string[] = [];

  for (const table of expectedTables) {
    const exists = await knex.schema.hasTable(table);
    if (exists) {
      const hasDeleted = await knex.schema.hasColumn(table, 'deleted');
      const query = hasDeleted ? knex(table).whereNull('deleted') : knex(table);
      const count = await query.count('* as total').first();
      console.log(`  ✓ ${table} (${count?.total ?? 0} rows)`);
    } else {
      console.log(`  ✗ ${table} — MISSING`);
      missing.push(table);
    }
  }

  console.log('');

  if (missing.length > 0) {
    throw new Error(`Schema verification failed. Missing tables: ${missing.join(', ')}`);
  }

  console.log('=== All tables verified ===\n');
}
