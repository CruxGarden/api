import { buildSitemap, SITEMAP_MAX_URLS } from './sitemap';

describe('buildSitemap', () => {
  const origin = 'https://crux.garden';

  it('lists each author once, then every crux, with lastmod days', () => {
    const xml = buildSitemap(origin, [
      { username: 'dan', slug: 'newest', updated: '2026-10-03T12:00:00Z' },
      { username: 'ada', slug: 'engine', updated: new Date('2026-10-02') },
      { username: 'dan', slug: 'older', updated: '2026-09-01T00:00:00Z' },
    ]);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.match(/<loc>/g)).toHaveLength(5);
    expect(xml).toContain(
      '<url><loc>https://crux.garden/dan</loc><lastmod>2026-10-03</lastmod></url>',
    );
    expect(xml).toContain(
      '<url><loc>https://crux.garden/ada/engine</loc><lastmod>2026-10-02</lastmod></url>',
    );
    expect(xml.indexOf('/ada</loc>')).toBeLessThan(xml.indexOf('/dan/newest'));
  });

  it('escapes what a slug or username could carry', () => {
    const xml = buildSitemap(origin, [
      { username: 'a&b', slug: 'x<y>"z', updated: 'not a date' },
    ]);

    expect(xml).toContain('<loc>https://crux.garden/a%26b/x%3Cy%3E%22z</loc>');
    expect(xml).not.toContain('<lastmod>');
  });

  it('never exceeds the protocol limit', () => {
    const rows = Array.from({ length: SITEMAP_MAX_URLS }, (_, i) => ({
      username: `author-${i % 10}`,
      slug: `crux-${i}`,
      updated: '2026-10-01T00:00:00Z',
    }));

    const xml = buildSitemap(origin, rows);

    expect(xml.match(/<url>/g)).toHaveLength(SITEMAP_MAX_URLS);
    expect(xml).toContain('<loc>https://crux.garden/author-9</loc>');
    expect(xml).not.toContain(`crux-${SITEMAP_MAX_URLS - 1}<`);
  });

  it('is a valid empty urlset when nothing is listed', () => {
    expect(buildSitemap(origin, [])).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>',
    );
  });
});
