import { publicCruxMeta, withPublicMeta } from './public-meta';

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
});
