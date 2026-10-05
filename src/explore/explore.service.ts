import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { LoggerService } from '../common/services/logger.service';
import { webOrigin } from '../common/helpers/web-origin';
import { buildSitemap, SitemapRow, SITEMAP_MAX_URLS } from './sitemap';
import {
  canonicalFor,
  notFoundHtml,
  parsePreviewPath,
  previewDescription,
  PreviewCard,
  renderPreviewHtml,
  SITE_DESCRIPTION,
  SITE_NAME,
} from './preview-html';
import {
  ExploreRepository,
  ExploreCruxFilters,
  ExploreAuthorFilters,
} from './explore.repository';

@Injectable()
export class ExploreService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly exploreRepository: ExploreRepository,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ExploreService');
  }

  getCruxesQuery(filters: ExploreCruxFilters): Knex.QueryBuilder {
    return this.exploreRepository.findCruxesQuery(filters);
  }

  getAuthorsQuery(filters: ExploreAuthorFilters): Knex.QueryBuilder {
    return this.exploreRepository.findAuthorsQuery(filters);
  }

  async getPopularTags(limit?: number, kind?: string) {
    return this.exploreRepository.findPopularTags(limit, kind);
  }

  /**
   * Link-preview HTML for a website path (ADR 0084). Private, missing and
   * taken-down pages answer 404 with no details; unlisted and non-Discoverable
   * ones are previewed (the link holder shares them) but marked noindex.
   */
  async getPreview(path: unknown): Promise<{ status: number; html: string }> {
    const origin = webOrigin();
    const target = parsePreviewPath(path);
    if (!target) return { status: 400, html: notFoundHtml(origin) };
    const url = canonicalFor(origin, target);
    const siteIcon = `${origin}/apple-touch-icon.png`;
    const missing = { status: 404, html: notFoundHtml(origin) };

    if (target.kind === 'site')
      return {
        status: 200,
        html: renderPreviewHtml({
          title: SITE_NAME,
          description: SITE_DESCRIPTION,
          url,
          image: siteIcon,
        }),
      };

    const author = await this.exploreRepository.findPreviewAuthor(
      target.username,
    );
    if (!author) return missing;
    const handle = author.username;

    if (target.kind === 'author') {
      const avatar = avatarUrl(author.meta);
      return {
        status: 200,
        html: renderPreviewHtml({
          title: `${author.display_name || handle} (@${handle}) — ${SITE_NAME}`,
          description:
            previewDescription(author.bio) ??
            `Creations published by @${handle} on ${SITE_NAME}.`,
          url: canonicalFor(origin, { kind: 'author', username: handle }),
          image: avatar ?? siteIcon,
          type: 'profile',
        }),
      };
    }

    const crux = await this.exploreRepository.findPreviewCrux(
      author.id,
      target.slug,
    );
    if (!crux || (await this.exploreRepository.hasActiveTakedown(crux.id)))
      return missing;
    const packaged = crux.kind === 'tool' || crux.kind === 'mood';
    const cover =
      !packaged &&
      (await this.exploreRepository.hasPublishedCover(crux.id, COVER_PATH));
    const purpose = (crux.meta?.summary as { purpose?: unknown } | undefined)
      ?.purpose;
    const what =
      crux.kind === 'tool'
        ? 'A Crux Tool'
        : crux.kind === 'mood'
          ? 'A Mood'
          : 'A creation';
    const card: PreviewCard = {
      title: `${crux.title || crux.slug} — ${SITE_NAME}`,
      description:
        previewDescription(crux.description) ??
        previewDescription(purpose) ??
        `${what} by @${handle} published with ${SITE_NAME}.`,
      url: canonicalFor(origin, {
        kind: 'crux',
        username: handle,
        slug: crux.slug,
      }),
      image: cover ? `${publishOrigin(crux.id)}/${COVER_PATH}` : siteIcon,
      imageLarge: !!cover,
      noindex: crux.visibility !== 'public' || crux.discoverable !== true,
      type: 'article',
    };
    return { status: 200, html: renderPreviewHtml(card) };
  }

  /** Author pages and crux pages on the public website, capped at the protocol's limit. */
  async getSitemap(): Promise<string> {
    const rows: SitemapRow[] =
      await this.exploreRepository.findSitemapQuery(SITEMAP_MAX_URLS);
    return buildSitemap(webOrigin(), rows);
  }
}

/** The publish pipeline ships the workspace thumbnail as this file (app `public-cover.ts`). */
export const COVER_PATH = '_crux/cover.jpg';

/** A published crux's own origin; `PUBLISH_ORIGIN_TEMPLATE` overrides for self-hosting. */
export function publishOrigin(cruxId: string): string {
  const template =
    process.env.PUBLISH_ORIGIN_TEMPLATE ||
    'https://{cruxId}.publish.crux.garden';
  return template.replace('{cruxId}', cruxId).replace(/\/+$/, '');
}

/** An author's avatar as an absolute https URL, or undefined (data URLs never qualify). */
export function avatarUrl(
  meta: Record<string, unknown> | null | undefined,
): string | undefined {
  const raw = meta?.avatarUrl ?? meta?.avatar_url;
  if (typeof raw !== 'string' || !raw) return undefined;
  if (/^https:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    const api = (
      process.env.PUBLIC_API_URL ||
      process.env.BASE_URL ||
      'https://api.crux.garden'
    ).replace(/\/+$/, '');
    return /^https:\/\//i.test(api) ? `${api}${raw}` : undefined;
  }
  return undefined;
}
