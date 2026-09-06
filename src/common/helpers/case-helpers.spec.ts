import {
  toTableFields,
  toEntityFields,
  deepConvertKeys,
  camelCaseKey,
} from './case-helpers';

describe('case helpers', () => {
  it('convert column names and leave JSON column contents untouched', () => {
    const row = toTableFields({
      cruxId: 'c1',
      homeId: 'h1',
      meta: {
        publishedAt: '2026-09-06T00:00:00Z',
        publishLayout: 'bucket-per-crux',
        authorSnapshots: { 'a-1': { avatarFingerprint: 'x' } },
        form_schema: { some_field: 1 },
        game: { shelfPath: 'shelf.json' },
      },
    });
    expect(Object.keys(row)).toEqual(['crux_id', 'home_id', 'meta']);
    expect(row.meta).toEqual({
      publishedAt: '2026-09-06T00:00:00Z',
      publishLayout: 'bucket-per-crux',
      authorSnapshots: { 'a-1': { avatarFingerprint: 'x' } },
      form_schema: { some_field: 1 },
      game: { shelfPath: 'shelf.json' },
    });
    // and back: the entity carries the JSON exactly as stored
    const entity = toEntityFields({ crux_id: 'c1', meta: row.meta });
    expect(entity).toEqual({ cruxId: 'c1', meta: row.meta });
  });

  it('deepConvertKeys is the old behaviour, kept for the data migration', () => {
    expect(
      deepConvertKeys(
        { published_at: 1, game: { shelf_path: 'x' }, list: [{ a_b: 1 }] },
        camelCaseKey,
      ),
    ).toEqual({ publishedAt: 1, game: { shelfPath: 'x' }, list: [{ aB: 1 }] });
  });
});
