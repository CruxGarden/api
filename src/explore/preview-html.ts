/**
 * Link-preview HTML for chat and social crawlers (ADR 0084, ROADMAP EF11).
 *
 * The public website is a client-rendered app: a crawler that does not run
 * scripts sees only the site-wide card in index.html. The edge sends known
 * preview crawlers here instead, and this answers with a minimal document
 * whose head carries the page's own title, description, canonical address,
 * Open Graph and Twitter tags. Everything interpolated is HTML-escaped.
 */
import { RESERVED_USERNAMES } from '../common/helpers/reserved-usernames';

export const SITE_NAME = 'Crux Garden';
export const SITE_DESCRIPTION =
  'You can grow anything. A game, a website, a useful little tool. Build with AI, keep your history, and share what you make in Crux Garden.';
export const MAX_PREVIEW_PATH = 512;

export type PreviewTarget =
  | { kind: 'site'; path: string }
  | { kind: 'author'; username: string }
  | { kind: 'crux'; username: string; slug: string };

export interface PreviewCard {
  title: string;
  description: string;
  /** Absolute canonical URL of the real page. */
  url: string;
  image?: string;
  /** A wide cover worth a large card; a small icon/avatar is not. */
  imageLarge?: boolean;
  /** Not Discoverable / unlisted: preview for link holders, but never index. */
  noindex?: boolean;
  type?: 'website' | 'profile' | 'article';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One or two sentences; longer text is cut at a word (mirrors the app's metaDescription). */
export function previewDescription(
  text: unknown,
  max = 200,
): string | undefined {
  if (typeof text !== 'string') return undefined;
  const clean = Array.from(text)
    .filter((char) => char.charCodeAt(0) >= 32 || /\s/.test(char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * Which public page a URL path names. `null` for a malformed path. The
 * website's own sections (explore, plans, docs, legal pages…) and the root
 * get the site card.
 */
export function parsePreviewPath(raw: unknown): PreviewTarget | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  if (raw.length > MAX_PREVIEW_PATH) return null;
  const path = raw.split(/[?#]/)[0];
  let segments: string[];
  try {
    segments = path
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments.some((s) => Array.from(s).some((c) => c.charCodeAt(0) < 32)))
    return null;
  const site = (): PreviewTarget => ({
    kind: 'site',
    path: segments.length
      ? `/${segments.map((s) => encodeURIComponent(s)).join('/')}`
      : '/',
  });
  if (!segments.length) return site();
  const username = segments[0].replace(/^@/, '');
  if (!username || RESERVED_USERNAMES.includes(username.toLowerCase()))
    return site();
  if (segments.length === 1) return { kind: 'author', username };
  return { kind: 'crux', username, slug: segments[1] };
}

/** The real page's address for a target, under the website origin. */
export function canonicalFor(origin: string, target: PreviewTarget): string {
  if (target.kind === 'site') return `${origin}${target.path}`;
  const user = `${origin}/${encodeURIComponent(target.username)}`;
  return target.kind === 'author'
    ? user
    : `${user}/${encodeURIComponent(target.slug)}`;
}

/** The whole document. `url` is the canonical page a person should land on. */
export function renderPreviewHtml(card: PreviewCard): string {
  const e = escapeHtml;
  const image = card.image;
  const tags = [
    `<meta charset="utf-8">`,
    `<title>${e(card.title)}</title>`,
    `<meta name="description" content="${e(card.description)}">`,
    `<link rel="canonical" href="${e(card.url)}">`,
    card.noindex ? `<meta name="robots" content="noindex">` : '',
    `<meta property="og:site_name" content="${e(SITE_NAME)}">`,
    `<meta property="og:type" content="${e(card.type ?? 'website')}">`,
    `<meta property="og:title" content="${e(card.title)}">`,
    `<meta property="og:description" content="${e(card.description)}">`,
    `<meta property="og:url" content="${e(card.url)}">`,
    image ? `<meta property="og:image" content="${e(image)}">` : '',
    `<meta name="twitter:card" content="${image && card.imageLarge ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${e(card.title)}">`,
    `<meta name="twitter:description" content="${e(card.description)}">`,
    image ? `<meta name="twitter:image" content="${e(image)}">` : '',
  ].filter(Boolean);
  // No meta refresh: a crawler fetching the canonical address is routed here
  // again, so a refresh to it could read as a redirect loop. People who reach
  // this document directly follow the link.
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    ...tags.map((t) => `  ${t}`),
    '</head>',
    '<body>',
    `  <h1>${e(card.title)}</h1>`,
    `  <p>${e(card.description)}</p>`,
    `  <p><a href="${e(card.url)}">Open on ${e(SITE_NAME)}</a></p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function notFoundHtml(origin: string): string {
  return renderPreviewHtml({
    title: `Not found — ${SITE_NAME}`,
    description: "This page doesn't exist or is private.",
    url: `${origin}/`,
    noindex: true,
  });
}
