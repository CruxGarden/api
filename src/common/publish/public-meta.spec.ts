import {
  publicCruxMeta,
  withConversationPolicy,
  withPublicMeta,
} from './public-meta';

describe('public crux meta', () => {
  const meta = {
    summary: { text: 'A game' },
    messages: [{ role: 'user', content: 'hi' }],
    authorSnapshots: { a: { username: 'x' } },
    personaSnapshots: { p: { name: 'Keeper' } },
    mood: { name: 'Sea Glass' },
    tags: ['game'],
    template: '5ws',
    game: { shelfPath: 'shelf.json' },
    growthCount: 3,
    publishedAt: '2026-09-06T00:00:00Z',
    publishedVersion: 2,
    publishLayout: 'bucket-per-crux',
    // private working state
    settings: {
      model: 'claude-opus-5',
      systemPrompt: 'secret instructions',
      previewPort: 4321,
    },
    turnJob: { id: 'job' },
    turnQueue: [],
    projectFolder: '/Users/daniel/CruxGarden/5ws-abc',
    skills: ['5ws'],
    snapshot: { id: 's' },
    publishedFingerprints: { 'index.html': 'abc' },
  };

  it('keeps what the public page needs and drops the working state', () => {
    const out = publicCruxMeta(meta)!;
    expect(Object.keys(out).sort()).toEqual(
      [
        'summary',
        'messages',
        'authorSnapshots',
        'personaSnapshots',
        'mood',
        'tags',
        'template',
        'game',
        'growthCount',
        'publishedAt',
        'publishedVersion',
        'publishLayout',
        'conversationPublished',
      ].sort(),
    );
    expect(out).not.toHaveProperty('settings');
    expect(out).not.toHaveProperty('projectFolder');
    expect(out).not.toHaveProperty('turnJob');
    expect(JSON.stringify(out)).not.toContain('secret instructions');
    expect(JSON.stringify(out)).not.toContain('/Users/');
  });

  it('passes null and undefined through, and leaves the rest of the row alone', () => {
    expect(publicCruxMeta(null)).toBeNull();
    expect(publicCruxMeta(undefined)).toBeUndefined();
    const row = withPublicMeta({ id: 'c1', title: 'T', meta });
    expect(row.id).toBe('c1');
    expect(row.meta).not.toHaveProperty('settings');
    expect(row.meta).toHaveProperty('messages');
  });

  it('ADR 0084: a private conversation is absent and says so', () => {
    const out = publicCruxMeta({ ...meta, conversationPublished: false })!;
    expect(out).not.toHaveProperty('messages');
    expect(out).not.toHaveProperty('personaSnapshots');
    expect(out.conversationPublished).toBe(false);
    expect(out.summary).toEqual({ text: 'A game' });
    // pre-0084 metadata keeps publishing its conversation
    expect(publicCruxMeta(meta)!.conversationPublished).toBe(true);
  });

  it('ADR 0084: messages marked excludedFromPublish never reach the public', () => {
    const out = publicCruxMeta({
      ...meta,
      conversationPublished: true,
      messages: [
        { role: 'user', content: 'keep' },
        {
          role: 'user',
          content: 'my key is sk-123',
          excludedFromPublish: true,
        },
        { role: 'assistant', content: 'also kept', excludedFromPublish: false },
      ],
    })!;
    expect(out.messages).toEqual([
      { role: 'user', content: 'keep' },
      { role: 'assistant', content: 'also kept', excludedFromPublish: false },
    ]);
    expect(JSON.stringify(out)).not.toContain('sk-123');
  });

  it('withConversationPolicy strips before storage without touching its input', () => {
    const input = { ...meta, conversationPublished: false };
    const stored = withConversationPolicy(input);
    expect(stored).not.toHaveProperty('messages');
    expect(stored).not.toHaveProperty('personaSnapshots');
    expect(stored.conversationPublished).toBe(false);
    expect(stored.settings).toEqual(meta.settings);
    expect(input.messages).toHaveLength(1);
  });

  it('a published Tool exposes only the sanitized trust summary', () => {
    const out = withPublicMeta({
      id: 't1',
      author_username: 'ada',
      meta: {
        toolPackage: {
          version: 1,
          artifactId: 'a',
          fingerprint: 'f',
          size: 2048,
          fileCount: 3,
          unpackedBytes: 4096,
          summary: {
            name: 'Sketch\u0007 <b>',
            version: '1.2.0',
            publisher: 'old-name',
            upstreamUrl: 'https://github.com/processing/p5.js',
            license: 'LGPL-2.1',
            sizeBytes: 2048,
            permissions: ['document', 'shell', 'public-edition'],
            sandboxed: false,
            greeting: 'secret greeting',
            hostScript: 'rm -rf /',
          },
        },
        toolManifest: { context: 'private context', greeting: 'hi' },
        toolSummary: { name: 'forged', evil: true },
      },
    });
    expect(out.meta!.toolSummary).toEqual({
      name: 'Sketch <b>',
      version: '1.2.0',
      publisher: 'ada',
      upstreamUrl: 'https://github.com/processing/p5.js',
      license: 'LGPL-2.1',
      sizeBytes: 2048,
      permissions: ['document', 'public-edition'],
      sandboxed: true,
    });
    expect(out.meta).not.toHaveProperty('toolManifest');
    const json = JSON.stringify(out.meta);
    for (const leak of [
      'secret greeting',
      'rm -rf',
      'private context',
      'evil',
      'forged',
    ])
      expect(json).not.toContain(leak);
  });

  it('older Tool publications derive the summary from the stored manifest; non-Tools have none', () => {
    const out = publicCruxMeta({
      toolPackage: { size: 99 },
      toolManifest: {
        name: 'Pixel',
        releaseVersion: 'not a version!',
        toolInfo: { upstream: 'javascript:alert(1)' },
        routes: [{ extensions: ['.png'], folder: 'art' }],
        greeting: 'hello',
      },
    })!;
    expect(out.toolSummary).toEqual({
      name: 'Pixel',
      sizeBytes: 99,
      permissions: ['file-drops'],
      sandboxed: true,
    });
    expect(publicCruxMeta({ toolSummary: { name: 'x' } })).not.toHaveProperty(
      'toolSummary',
    );
  });
});
