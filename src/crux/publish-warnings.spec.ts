import knex from 'knex';
import { publishWarnings } from './publish-warnings';
import { CruxRepository } from './crux.repository';

describe('publish warnings', () => {
  it('returns none under the soft limit, without a check, or on an unlimited plan', () => {
    expect(publishWarnings(undefined)).toEqual([]);
    expect(
      publishWarnings({ used: 1, limit: 10, softLimit: 12, warn: false }),
    ).toEqual([]);
    expect(
      publishWarnings({ used: 50, limit: 0, softLimit: 0, warn: true }),
    ).toEqual([]);
  });

  it('describes a storage soft-limit crossing in plain units', () => {
    const [warning] = publishWarnings({
      used: 1.3 * 1024 ** 3,
      limit: 1024 ** 3,
      softLimit: 1.2 * 1024 ** 3,
      warn: true,
    });
    expect(warning).toEqual({
      kind: 'storage_soft_limit',
      message: expect.stringContaining('1.3 GB'),
      usedBytes: 1.3 * 1024 ** 3,
      limitBytes: 1024 ** 3,
    });
    expect(warning.message).toContain('2.0 GB');
  });
});

describe('link-only Moods on the public garden (ADR 0084)', () => {
  const repository = () =>
    new CruxRepository(
      { query: () => knex({ client: 'pg' }) } as never,
      { createChildLogger: () => ({}) } as never,
    );

  it('lists a Mood only when it is Discoverable; other kinds are unaffected', () => {
    for (const kind of [undefined, 'mood', 'creations'] as const) {
      const { sql, bindings } = repository()
        .findPublicByAuthorQuery('author-1', kind)
        .toSQL()
        .toNative();
      expect(sql).toMatch(
        /\("kind" is null or not "kind" = \$\d+ or "discoverable" = \$\d+\)/,
      );
      expect(bindings).toEqual(expect.arrayContaining(['mood', true]));
      expect(sql).toContain('"visibility" = $2');
    }
  });
});
