import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  LeaderboardService,
  resolveDay,
  MAX_SCORE,
} from './leaderboard.service';
import type { LeaderboardRow } from './leaderboard.repository';

const logger = {
  createChildLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
} as never;
const ok = <T>(data: T) => Promise.resolve({ data, error: null });

function fakeRepo() {
  const rows: LeaderboardRow[] = [];
  const sorted = (cruxId: string, day: string) =>
    rows
      .filter((r) => r.crux_id === cruxId && r.day === day)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.seconds - b.seconds ||
          new Date(a.at).getTime() - new Date(b.at).getTime(),
      );
  return {
    rows,
    forDay: jest.fn((c: string, d: string, limit: number) =>
      ok(sorted(c, d).slice(0, limit)),
    ),
    claim: jest.fn((row: Omit<LeaderboardRow, 'at'>) => {
      const existing = rows.find(
        (r) =>
          r.crux_id === row.crux_id &&
          r.day === row.day &&
          r.account_id === row.account_id,
      );
      if (existing) return ok({ row: existing, inserted: false });
      const saved = { ...row, at: new Date(2026, 8, 5, 12, rows.length) };
      rows.push(saved);
      return ok({ row: saved, inserted: true });
    }),
    rankOf: jest.fn((c: string, d: string, a: string) => {
      const i = sorted(c, d).findIndex((r) => r.account_id === a);
      return ok(i === -1 ? null : i + 1);
    }),
  };
}
const cruxes = {
  findById: async (id: string) =>
    id.startsWith('crux') ? { id, authorId: 'a' } : null,
};
const authors = {
  findByAccountId: async (id: string) => ({
    id: `author-${id}`,
    username: `user-${id}`,
  }),
};

describe('LeaderboardService', () => {
  it('resolves "today" and validates days', () => {
    expect(resolveDay('today', new Date('2026-09-05T23:59:00Z'))).toBe(
      '2026-09-05',
    );
    expect(resolveDay('2026-09-04')).toBe('2026-09-04');
    expect(() => resolveDay('yesterday')).toThrow(BadRequestException);
    expect(() => resolveDay('2026-13-40')).toThrow(BadRequestException);
  });

  it('ranks by score, then speed; the first post of the day counts and later ones are practice', async () => {
    const repo = fakeRepo();
    const svc = new LeaderboardService(
      repo as never,
      cruxes as never,
      authors as never,
      logger,
    );
    await svc.post('crux-1', '2026-09-05', 'acct-a', 7, 200);
    await svc.post('crux-1', '2026-09-05', 'acct-b', 10, 120);
    const c = await svc.post('crux-1', '2026-09-05', 'acct-c', 10, 90);
    expect(c.you).toEqual({ rank: 1, score: 10, seconds: 90, counted: true });
    expect(c.entries.map((e) => e.name)).toEqual([
      'user-acct-c',
      'user-acct-b',
      'user-acct-a',
    ]);
    // a second round the same day cannot move the board
    const again = await svc.post('crux-1', '2026-09-05', 'acct-a', 10, 30);
    expect(again.you).toEqual({
      rank: 3,
      score: 7,
      seconds: 200,
      counted: false,
    });
    expect(repo.rows).toHaveLength(3);
    // another day is another board
    const other = await svc.board('crux-1', '2026-09-06', null);
    expect(other.entries).toEqual([]);
    expect(other.you).toBeNull();
  });

  it('reading is public and shows the caller their place when signed in', async () => {
    const repo = fakeRepo();
    const svc = new LeaderboardService(
      repo as never,
      cruxes as never,
      authors as never,
      logger,
    );
    await svc.post('crux-1', 'today', 'acct-a', 9, 100);
    const anon = await svc.board('crux-1', 'today', null);
    expect(anon.entries).toHaveLength(1);
    expect(anon.you).toBeNull();
    const mine = await svc.board('crux-1', 'today', 'acct-a');
    expect(mine.you?.rank).toBe(1);
    const stranger = await svc.board('crux-1', 'today', 'acct-z');
    expect(stranger.you).toBeNull();
  });

  it('refuses impossible scores and unknown cruxes', async () => {
    const repo = fakeRepo();
    const svc = new LeaderboardService(
      repo as never,
      cruxes as never,
      authors as never,
      logger,
    );
    await expect(
      svc.post('crux-1', 'today', 'acct-a', MAX_SCORE + 1, 10),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.post('crux-1', 'today', 'acct-a', 5, 10_000),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.post('crux-1', 'today', 'acct-a', 5.5, 10),
    ).rejects.toThrow(BadRequestException);
    await expect(svc.board('nope', 'today', null)).rejects.toThrow(
      NotFoundException,
    );
  });
});
