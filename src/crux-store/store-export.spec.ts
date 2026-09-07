import { BadRequestException } from '@nestjs/common';
import { fromStoreExport, toStoreExport } from './store-export';

describe('Crux Store export format', () => {
  it('round-trips public and per-visitor rows through one document', () => {
    const doc = toStoreExport(
      'c1',
      [
        {
          key: 'board',
          value: { top: [1, 2] },
          mode: 'public',
          visitorId: null,
        },
        {
          key: 'played',
          value: { score: 87 },
          mode: 'protected',
          visitorId: 'v1',
        },
        { key: 'streak', value: 3, mode: 'protected', visitorId: 'v1' },
        {
          key: 'played',
          value: { score: 12 },
          mode: 'protected',
          visitorId: 'v2',
        },
      ],
      new Date('2026-09-07T00:00:00Z'),
    );
    expect(doc).toEqual({
      format: 'crux-store',
      version: 1,
      cruxId: 'c1',
      exportedAt: '2026-09-07T00:00:00.000Z',
      public: { board: { top: [1, 2] } },
      protected: {
        v1: { played: { score: 87 }, streak: 3 },
        v2: { played: { score: 12 } },
      },
    });
    const back = fromStoreExport(JSON.parse(JSON.stringify(doc)));
    expect(back).toHaveLength(4);
    expect(back).toContainEqual({
      key: 'streak',
      value: 3,
      mode: 'protected',
      visitorId: 'v1',
    });
    expect(back).toContainEqual({
      key: 'board',
      value: { top: [1, 2] },
      mode: 'public',
      visitorId: null,
    });
  });

  it('refuses anything that is not a Crux Store export, loudly', () => {
    expect(() => fromStoreExport('nope')).toThrow(BadRequestException);
    expect(() => fromStoreExport({ format: 'firebase' })).toThrow(
      /Not a Crux Store export/,
    );
    expect(() => fromStoreExport({ format: 'crux-store', version: 2 })).toThrow(
      /version/,
    );
    expect(() =>
      fromStoreExport({ format: 'crux-store', version: 1, public: [] }),
    ).toThrow(/must be objects/);
    expect(() =>
      fromStoreExport({
        format: 'crux-store',
        version: 1,
        protected: { v1: 5 },
      }),
    ).toThrow(/visitor ids to objects/);
    expect(() =>
      fromStoreExport({ format: 'crux-store', version: 1, public: { '': 1 } }),
    ).toThrow(/Invalid key/);
    // a minimal, empty export is fine
    expect(fromStoreExport({ format: 'crux-store', version: 1 })).toEqual([]);
  });
});
