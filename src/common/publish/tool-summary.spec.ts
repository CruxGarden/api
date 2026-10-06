import * as JSZip from 'jszip';
import {
  detectLicense,
  licenseCandidates,
  sanitizeToolSummary,
  summaryFromToolPackage,
} from './tool-summary';

describe('tool trust summary', () => {
  it('recognises common licence texts and leaves unknown ones unnamed', () => {
    expect(
      detectLicense(
        'MIT License\n\nPermission is hereby granted, free of charge, to any person',
      ),
    ).toBe('MIT');
    expect(
      detectLicense(
        'GNU LESSER GENERAL PUBLIC LICENSE\n Version 2.1, February 1999',
      ),
    ).toBe('LGPL-2.1');
    expect(detectLicense('Apache License\n Version 2.0, January 2004')).toBe(
      'Apache-2.0',
    );
    expect(detectLicense('All rights reserved. Do whatever.')).toBeUndefined();
  });

  it('prefers root licence files, then a licenses/ folder', () => {
    expect(
      licenseCandidates([
        'licenses/p5-LICENSE.txt',
        'index.html',
        'LICENSE.md',
        'deep/LICENSE',
      ]),
    ).toEqual(['LICENSE.md', 'licenses/p5-LICENSE.txt']);
  });

  it('rejects malformed fields one by one', () => {
    expect(sanitizeToolSummary({ name: '' })).toBeUndefined();
    expect(sanitizeToolSummary('Sketch')).toBeUndefined();
    expect(
      sanitizeToolSummary({
        name: 'Sketch',
        version: '<script>',
        publisher: 'a b',
        upstreamUrl: 'https://user:pw@example.com/',
        license: 'MIT; DROP TABLE',
        sizeBytes: -1,
        permissions: 'document',
      }),
    ).toEqual({ name: 'Sketch', sandboxed: true });
  });

  it('derives the summary from the validated package header and its licence', async () => {
    const zip = new JSZip();
    const licence = 'MIT License\nPermission is hereby granted, free of charge';
    zip.file('files/index.html', '<h1>x</h1>');
    zip.file('files/LICENSE', licence);
    zip.file(
      'tool-package.json',
      JSON.stringify({
        format: 'crux-tool',
        version: 1,
        tool: {
          id: 'pix',
          name: 'Pixel',
          releaseVersion: '2.0.1',
          entryFile: 'index.html',
          share: true,
          document: { path: 'data/p.json', seed: {} },
          toolInfo: { upstream: 'https://example.com/pixel', name: 'Pixel' },
          greeting: 'never public',
        },
        files: [
          { path: 'index.html', size: 10, mimeType: 'text/html' },
          { path: 'LICENSE', size: licence.length, mimeType: 'text/plain' },
        ],
      }),
    );
    const data = await zip.generateAsync({ type: 'nodebuffer' });
    expect(await summaryFromToolPackage(data, { publisher: 'ada' })).toEqual({
      name: 'Pixel',
      version: '2.0.1',
      publisher: 'ada',
      upstreamUrl: 'https://example.com/pixel',
      license: 'MIT',
      sizeBytes: data.length,
      permissions: ['document', 'public-edition'],
      sandboxed: true,
    });
  });
});
