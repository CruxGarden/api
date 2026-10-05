/**
 * First path segments the website keeps for itself. A garden lives at
 * `/{username}`, so a person with one of these names would have a public
 * address the site's router never reaches. The app keeps the same list
 * (`app/src/lib/site.ts`).
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'explore',
  'plans',
  'billing',
  'docs',
  'blog',
  'subscribed',
  'home',
  'c',
  'terms',
  'privacy',
  'contact',
  'sitemap.xml',
  'robots.txt',
  'assets',
  'fonts',
];

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.includes(
    username.replace(/^@/, '').trim().toLowerCase(),
  );
}
