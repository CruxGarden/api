import { isAllowedOrigin } from './cors-origin';

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
});
