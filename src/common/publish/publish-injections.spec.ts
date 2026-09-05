import { applyInjections } from './publish-injections';
import Artifact from '../../artifact/entities/artifact.entity';

function html(
  path: string,
  body = '<html><head></head><body>hi</body></html>',
) {
  return {
    buffer: Buffer.from(body, 'utf-8'),
    artifact: {
      id: `art-${path}`,
      filename: path.split('/').pop(),
      mimeType: 'text/html',
      meta: { path },
    } as unknown as Artifact,
  };
}

describe('publish injections', () => {
  const CRUX_ID = '11111111-2222-3333-4444-555555555555';

  function inject(path: string, opts?: { cruxId?: string; apiBase?: string }) {
    const { buffer, artifact } = html(path);
    const result = applyInjections(buffer, artifact, [artifact], undefined, {
      cruxId: CRUX_ID,
      apiBase: 'https://api.crux.garden',
      ...opts,
    });
    return { text: result.data.toString('utf-8'), applied: result.applied };
  }

  it('injects into html files and leaves the document intact', () => {
    const { text, applied } = inject('index.html');
    expect(applied).toContain('crux-store-client');
    expect(text).toContain('<script data-crux-inject>');
    expect(text).toContain('</head>');
    expect(text).toContain('hi');
  });

  // Regression: the store client used to wait for a `crux:session` postMessage
  // that only ever arrives inside the workspace iframe, so every store call on
  // a directly-visited published site hung forever.
  it('bakes the crux id and API base in so direct visits can reach the store', () => {
    const { text } = inject('index.html');
    expect(text).toContain(CRUX_ID);
    expect(text).toContain('https://api.crux.garden');
    // Ready without a parent frame
    expect(text).toContain('window.parent===window');
  });

  it('exposes the crux id and API base as window.crux.publish for pages that call the API directly', () => {
    const { text } = inject('index.html');
    expect(text).toContain(
      'window.crux.publish={cruxId:PUBLISHED_CRUX_ID,apiBase:PUBLISHED_API_BASE};',
    );
  });

  it('ignores session messages that do not come from the opener', () => {
    const { text } = inject('index.html');
    expect(text).toContain('e.source!==window.parent');
  });

  it('escapes the injected values so they cannot break out of the script block', () => {
    const { text } = inject('index.html', {
      apiBase: 'https://x/</script><script>evil()',
    });
    expect(text).not.toContain('</script><script>evil()');
    expect(text).toContain('\\u003c/script>');
  });

  it('applies nothing to non-html artifacts', () => {
    const artifact = {
      id: 'a1',
      filename: 'style.css',
      mimeType: 'text/css',
      meta: { path: 'style.css' },
    } as unknown as Artifact;
    const result = applyInjections(
      Buffer.from('body{}'),
      artifact,
      [artifact],
      undefined,
      {
        cruxId: CRUX_ID,
      },
    );
    expect(result.applied).toEqual([]);
    expect(result.data.toString('utf-8')).toBe('body{}');
  });

  it('injects nav sync into every page of a multi-page (Astro) site', () => {
    // A built Astro site has a root index.html plus nested pages; the web-app
    // auto-detection keys on the root one.
    const root = html('index.html');
    const nested = html('about/index.html');
    const result = applyInjections(
      nested.buffer,
      nested.artifact,
      [root.artifact, nested.artifact],
      undefined,
      { cruxId: CRUX_ID, apiBase: 'https://api.crux.garden' },
    );
    expect(result.applied).toContain('spa-navigate-sync');
    expect(result.applied).toContain('crux-store-client');
  });
});
