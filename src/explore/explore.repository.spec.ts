import knex from 'knex';
import { ExploreRepository } from './explore.repository';

/** Builds SQL without a database: the repository only composes queries. */
function repo() {
  const k = knex({ client: 'pg' });
  const dbService = { query: () => k } as any;
  const logger = { createChildLogger: () => ({}) } as any;
  return new ExploreRepository(dbService, logger);
}

describe('ExploreRepository query composition', () => {
  it('filters discoverable public cruxes and returns tags per row', () => {
    const { sql } = repo().findCruxesQuery({}).toSQL().toNative();
    expect(sql).toContain('"c"."visibility" = $1');
    expect(sql).toContain('"c"."discoverable" = $2');
    expect(sql).toContain('array_agg(t.label');
    expect(sql).toContain('order by "c"."updated" desc');
  });

  it('kind, author, text and tag filters compose', () => {
    const { sql, bindings } = repo()
      .findCruxesQuery({
        q: 'rain',
        kind: 'mood',
        author: 'Daniel',
        tag: ['ambient', 'dark'],
      })
      .toSQL()
      .toNative();
    expect(sql).toContain('"c"."kind" = ');
    expect(sql).toContain('lower(a.username) = ');
    expect(sql).toContain('"a"."username" ilike');
    expect(bindings).toEqual(
      expect.arrayContaining(['mood', 'daniel', '%rain%', 'ambient', 'dark']),
    );
    expect((sql.match(/exists \(select \*/g) ?? []).length).toBe(3); // search-in-tags + 2 tag filters
  });

  it('sorts newest by created and alpha by title', () => {
    expect(repo().findCruxesQuery({ sort: 'newest' }).toSQL().sql).toContain(
      'order by "c"."created" desc',
    );
    expect(repo().findCruxesQuery({ sort: 'alpha' }).toSQL().sql).toContain(
      'order by "c"."title" asc',
    );
  });

  it('ranks by relevance when there is a search term, unless another sort is asked for', () => {
    const { sql, bindings } = repo()
      .findCruxesQuery({ q: 'Rain' })
      .toSQL()
      .toNative();
    expect(sql).toContain('CASE');
    expect(sql).toContain('lower(c.title) = ');
    expect(sql).toMatch(/END ASC, c\.updated DESC/);
    expect(bindings).toEqual(
      expect.arrayContaining(['rain', 'rain%', '%rain%']),
    );
    expect(
      repo().findCruxesQuery({ q: 'rain', sort: 'alpha' }).toSQL().sql,
    ).toContain('order by "c"."title" asc');
    // no term → relevant falls back to recency
    expect(repo().findCruxesQuery({ sort: 'relevant' }).toSQL().sql).toContain(
      'order by "c"."updated" desc',
    );
  });

  it('"@name" searches authors by prefix and "#tag" filters by tag', () => {
    const at = repo().findCruxesQuery({ q: '@Dan' }).toSQL().toNative();
    expect(at.sql).toContain('lower(a.username) like ');
    expect(at.bindings).toEqual(expect.arrayContaining(['dan%']));
    expect(at.sql).not.toContain('"c"."title" ilike');
    const hash = repo().findCruxesQuery({ q: '#ambient' }).toSQL().toNative();
    expect(hash.bindings).toEqual(expect.arrayContaining(['ambient']));
    expect(hash.sql).not.toContain('"c"."title" ilike');
  });
});
