import type { Knex } from 'knex';

/**
 * Until 2026-09-06 the write path snake_cased keys at every depth, so JSON
 * `meta` columns hold `published_at` where the app wrote `publishedAt`. The
 * read path camel-cased them back, which is why nothing noticed until code
 * that reads rows directly (the publish-state lookup the edge router uses)
 * saw nothing published. Materialise that read-side conversion once; the
 * helpers now leave JSON contents alone.
 */
const TABLES = [
  'homes',
  'authors',
  'cruxes',
  'dimensions',
  'paths',
  'artifacts',
];

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
function deep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deep);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      out[camel(k)] = deep(v);
    return out;
  }
  return obj;
}

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    const rows = (await knex(table)
      .select('id', 'meta')
      .whereNotNull('meta')) as {
      id: string;
      meta: unknown;
    }[];
    for (const row of rows) {
      const fixed = deep(row.meta);
      if (JSON.stringify(fixed) !== JSON.stringify(row.meta)) {
        await knex(table)
          .where('id', row.id)
          .update({ meta: JSON.stringify(fixed) });
      }
    }
  }
}

export async function down(): Promise<void> {
  // Irreversible in principle (camelCase is what the app wrote); nothing to undo.
}
