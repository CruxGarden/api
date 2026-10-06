import {
  escapeHtml,
  parsePreviewPath,
  previewDescription,
  renderPreviewHtml,
} from './preview-html';
import { ExploreService } from './explore.service';
import { ExploreRepository } from './explore.repository';

describe('link-preview HTML (ADR 0084)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  describe('paths', () => {
    it('names authors and creations; the site keeps its own sections', () => {
      expect(parsePreviewPath('/alice')).toEqual({
        kind: 'author',
        username: 'alice',
      });
      expect(parsePreviewPath('/@alice/my-site/page/2?x=1#y')).toEqual({
        kind: 'crux',
        username: 'alice',
        slug: 'my-site',
      });
      expect(parsePreviewPath('/caf%C3%A9/a%20b')).toEqual({
        kind: 'crux',
        username: 'café',
        slug: 'a b',
      });
      expect(parsePreviewPath('/explore')).toEqual({
        kind: 'site',
        path: '/explore',
      });
      expect(parsePreviewPath('/')).toEqual({ kind: 'site', path: '/' });
    });

    it('refuses what is not a plain absolute path', () => {
      for (const bad of [
        undefined,
        '',
        'alice',
        'https://evil.example/alice',
        '/%E0%A4%A',
        '/a%0Ab',
        `/${'a'.repeat(600)}`,
      ])
        expect(parsePreviewPath(bad)).toBeNull();
    });
  });

  it('escapes everything it interpolates', () => {
    const html = renderPreviewHtml({
      title: '"><script>alert(1)</script>',
      description: 'it\'s <b>bold</b> & "quoted"',
      url: 'https://crux.garden/a/"onmouseover=x',
      image: 'https://x.example/i.jpg?a=1&b="2"',
      imageLarge: true,
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"onmouseover');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain(
      'it&#39;s &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;',
    );
    expect(html).toContain('content="summary_large_image"');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(html).not.toMatch(/http-equiv/i);
  });

  it('cuts long descriptions at a word', () => {
    const long = 'word '.repeat(80);
    const cut = previewDescription(long)!;
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(previewDescription('  ')).toBeUndefined();
  });

  describe('ExploreService.getPreview', () => {
    const crux = {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'my-site',
      title: 'My <Site>',
      description: 'A site about "things"',
      kind: 'page',
      visibility: 'public',
      discoverable: true,
      meta: {},
    };
    function fixture(overrides: Partial<Record<string, jest.Mock>> = {}) {
      const repo = {
        findPreviewAuthor: jest.fn(async () => ({
          id: 'a1',
          username: 'alice',
          display_name: 'Alice & Co',
          bio: null,
          meta: { avatarUrl: '/authors/a1/avatar' },
        })),
        findPreviewCrux: jest.fn(async () => crux),
        hasActiveTakedown: jest.fn(async () => false),
        hasPublishedCover: jest.fn(async () => true),
        ...overrides,
      };
      const service = new ExploreService(
        repo as never,
        { createChildLogger: () => ({}) } as never,
      );
      return { service, repo };
    }
    beforeEach(() => {
      process.env.PUBLIC_WEB_URL = 'https://crux.garden';
      process.env.PUBLIC_API_URL = 'https://api.crux.garden';
      delete process.env.PUBLISH_ORIGIN_TEMPLATE;
    });

    it('previews a creation with its cover, canonical address and Open Graph tags', async () => {
      const { service, repo } = fixture();
      const { status, html } = await service.getPreview('/alice/my-site');
      expect(status).toBe(200);
      expect(repo.findPreviewCrux).toHaveBeenCalledWith('a1', 'my-site');
      expect(html).toContain('<title>My &lt;Site&gt; — Crux Garden</title>');
      expect(html).toContain(
        '<link rel="canonical" href="https://crux.garden/alice/my-site">',
      );
      expect(html).toContain(
        `<meta property="og:image" content="https://${crux.id}.publish.crux.garden/_crux/cover.jpg">`,
      );
      expect(html).toContain('content="summary_large_image"');
      expect(html).toContain('A site about &quot;things&quot;');
      expect(html).not.toContain('noindex');
    });

    it('a taken-down, private or missing creation answers 404 without details', async () => {
      const takenDown = fixture({
        hasActiveTakedown: jest.fn(async () => true),
      });
      const r1 = await takenDown.service.getPreview('/alice/my-site');
      expect(r1.status).toBe(404);
      expect(r1.html).not.toContain('My &lt;Site&gt;');

      // Private rows are excluded by the query itself (visibility public/unlisted).
      const missing = fixture({ findPreviewCrux: jest.fn(async () => null) });
      expect(
        (await missing.service.getPreview('/alice/private-one')).status,
      ).toBe(404);
      const nobody = fixture({ findPreviewAuthor: jest.fn(async () => null) });
      expect((await nobody.service.getPreview('/ghost')).status).toBe(404);
      expect((await nobody.service.getPreview('nope')).status).toBe(400);
    });

    it('link-only creations and Moods preview for the link holder but are never indexed', async () => {
      const mood = fixture({
        findPreviewCrux: jest.fn(async () => ({
          ...crux,
          kind: 'mood',
          discoverable: false,
          description: null,
        })),
      });
      const { status, html } =
        await mood.service.getPreview('/alice/sea-glass');
      expect(status).toBe(200);
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('A Mood by @alice published with Crux Garden.');
      expect(html).toContain('content="summary"');
      expect(mood.repo.hasPublishedCover).not.toHaveBeenCalled();
    });

    it('previews a garden with the author avatar', async () => {
      const { service } = fixture();
      const { status, html } = await service.getPreview('/@alice');
      expect(status).toBe(200);
      expect(html).toContain('Alice &amp; Co (@alice) — Crux Garden');
      expect(html).toContain('https://api.crux.garden/authors/a1/avatar');
    });
  });

  describe('repository lookups', () => {
    /** Records the chain; `first()` answers with `row`. */
    function recorder(row: unknown) {
      const calls: [string, unknown[]][] = [];
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get:
            (_t, name: string) =>
            (...args: unknown[]) => {
              calls.push([name, args]);
              return name === 'first' ? Promise.resolve(row) : chain;
            },
        },
      );
      const repo = new ExploreRepository(
        { query: () => chain } as never,
        { createChildLogger: () => ({}) } as never,
      );
      return { repo, calls };
    }

    it('a crux preview reads only live public or unlisted rows of that author', async () => {
      const { repo, calls } = recorder({ id: 'c' });
      await repo.findPreviewCrux('a1', 'my-site');
      expect(calls).toEqual(
        expect.arrayContaining([
          ['from', ['cruxes']],
          ['where', ['author_id', 'a1']],
          ['where', ['slug', 'my-site']],
          ['whereIn', ['visibility', ['public', 'unlisted']]],
          ['whereNull', ['deleted']],
        ]),
      );
      const byId = recorder(null);
      expect(
        await byId.repo.findPreviewCrux(
          'a1',
          '11111111-1111-4111-8111-111111111111',
        ),
      ).toBeNull();
      expect(byId.calls).toContainEqual([
        'where',
        ['id', '11111111-1111-4111-8111-111111111111'],
      ]);
    });

    it('takedowns in force and the published cover are looked up exactly', async () => {
      const t = recorder({ id: 't' });
      expect(await t.repo.hasActiveTakedown('c1')).toBe(true);
      expect(t.calls).toEqual(
        expect.arrayContaining([
          ['from', ['takedowns']],
          ['whereNull', ['lifted']],
          ['whereNull', ['deleted']],
        ]),
      );
      const c = recorder(undefined);
      expect(await c.repo.hasPublishedCover('c1', '_crux/cover.jpg')).toBe(
        false,
      );
      expect(c.calls).toContainEqual([
        'whereRaw',
        ["meta->>'path' = ?", ['_crux/cover.jpg']],
      ]);
    });
  });
});
