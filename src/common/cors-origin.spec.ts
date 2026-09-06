import { isAllowedOrigin, makeOriginCheck } from './cors-origin';

describe('isAllowedOrigin', () => {
  it('allows the site, publish subdomains and the desktop scheme without configuration', () => {
    expect(isAllowedOrigin(undefined, undefined)).toBe(true);
    expect(isAllowedOrigin('https://crux.garden', undefined)).toBe(true);
    expect(
      isAllowedOrigin(
        'https://0f8fad5b-d9cb-469f-a165-70867728950e.publish.crux.garden',
        undefined,
      ),
    ).toBe(true);
    // The packaged Electron renderer (crux-app:///index.html) reports this origin
    expect(isAllowedOrigin('crux-app://index.html', undefined)).toBe(true);
    expect(isAllowedOrigin('crux-app://', undefined)).toBe(true);
  });

  it('refuses everything else unless CORS_ORIGIN names it or is *', () => {
    expect(isAllowedOrigin('https://evil.example', undefined)).toBe(false);
    expect(isAllowedOrigin('http://crux.garden', undefined)).toBe(false);
    expect(isAllowedOrigin('https://crux.garden.evil.example', undefined)).toBe(
      false,
    );
    expect(
      isAllowedOrigin('https://notauuid.publish.crux.garden', undefined),
    ).toBe(false);
    expect(isAllowedOrigin('crux-app://index.html/../x', undefined)).toBe(
      false,
    );
    expect(isAllowedOrigin('http://localhost:8080', undefined)).toBe(false);
    expect(
      isAllowedOrigin('http://localhost:8080', 'http://localhost:8080'),
    ).toBe(true);
    expect(isAllowedOrigin('https://evil.example', '*')).toBe(true);
  });

  it('makeOriginCheck admits active custom domains (https only), caches, and refuses on lookup failure', async () => {
    const asked: string[] = [];
    let t = 0;
    const check = makeOriginCheck(
      async (h) => {
        asked.push(h);
        if (h === 'boom.example') throw new Error('db down');
        return h === 'blog.example.com';
      },
      { ttlMs: 1000, now: () => t },
    );
    // static list still wins without a lookup
    expect(await check('https://crux.garden')).toBe(true);
    expect(asked).toEqual([]);
    // an active banner passes; case and port are normalised away
    expect(await check('https://Blog.Example.com')).toBe(true);
    expect(await check('https://blog.example.com:443')).toBe(true);
    expect(asked).toEqual(['blog.example.com']); // second answer came from the cache
    // http never passes, even for a known domain
    expect(await check('http://blog.example.com')).toBe(false);
    // unknown and broken lookups refuse
    expect(await check('https://evil.example')).toBe(false);
    expect(await check('https://boom.example')).toBe(false);
    // cache expiry asks again
    t = 2000;
    expect(await check('https://blog.example.com')).toBe(true);
    expect(asked.filter((h) => h === 'blog.example.com')).toHaveLength(2);
    expect(await check(undefined)).toBe(true); // no Origin header: not a browser
  });
});
