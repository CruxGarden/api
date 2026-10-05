/** The sitemap protocol allows 50,000 URLs per file. */
export const SITEMAP_MAX_URLS = 50_000;

export interface SitemapRow {
  username: string;
  slug: string;
  updated: Date | string;
}

const xml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const day = (value: Date | string): string | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

/**
 * `{origin}/{username}` for every author with a listed crux, then
 * `{origin}/{username}/{slug}` for each crux. Rows arrive newest first, so an
 * author page's lastmod is its first row's and the cap drops the stalest
 * crux pages, never an author page.
 */
export function buildSitemap(origin: string, rows: SitemapRow[]): string {
  const authors = new Map<string, Date | string>();
  for (const row of rows)
    if (!authors.has(row.username)) authors.set(row.username, row.updated);

  const entries = [
    ...[...authors].map(([username, updated]) => ({
      loc: `${origin}/${encodeURIComponent(username)}`,
      updated,
    })),
    ...rows.map((row) => ({
      loc: `${origin}/${encodeURIComponent(row.username)}/${encodeURIComponent(row.slug)}`,
      updated: row.updated,
    })),
  ].slice(0, SITEMAP_MAX_URLS);

  const urls = entries.map(({ loc, updated }) => {
    const lastmod = day(updated);
    return `  <url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
