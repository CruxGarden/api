import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export interface LeaderboardRow {
  crux_id: string;
  day: string;
  account_id: string;
  name: string;
  score: number;
  seconds: number;
  at: Date | string;
}

@Injectable()
export class LeaderboardRepository {
  private static readonly TABLE = 'leaderboard_entries';
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('LeaderboardRepository');
  }

  /** Best first: score desc, then faster, then earlier. */
  async forDay(
    cruxId: string,
    day: string,
    limit: number,
  ): Promise<RepositoryResponse<LeaderboardRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<LeaderboardRow>(LeaderboardRepository.TABLE)
        .where({ crux_id: cruxId, day })
        .orderBy([
          { column: 'score', order: 'desc' },
          { column: 'seconds', order: 'asc' },
          { column: 'at', order: 'asc' },
        ])
        .limit(limit);
      return success(rows);
    } catch (error) {
      this.logger.error('forDay failed', error as Error);
      return failure(error);
    }
  }

  /**
   * Record the account's entry for the day. The first post wins: a conflict
   * leaves the existing row untouched and returns it, so a second round is
   * practice and cannot improve (or worsen) the score on the board.
   */
  async claim(
    row: Omit<LeaderboardRow, 'at'>,
  ): Promise<RepositoryResponse<{ row: LeaderboardRow; inserted: boolean }>> {
    try {
      const inserted = (await this.dbService.query().raw(
        `INSERT INTO leaderboard_entries (crux_id, day, account_id, name, score, seconds)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (crux_id, day, account_id) DO NOTHING
         RETURNING *`,
        [
          row.crux_id,
          row.day,
          row.account_id,
          row.name,
          row.score,
          row.seconds,
        ],
      )) as { rows: LeaderboardRow[] };
      if (inserted.rows?.length)
        return success({ row: inserted.rows[0], inserted: true });
      const existing = await this.dbService
        .query()
        .from<LeaderboardRow>(LeaderboardRepository.TABLE)
        .where({
          crux_id: row.crux_id,
          day: row.day,
          account_id: row.account_id,
        })
        .first();
      return success({ row: existing as LeaderboardRow, inserted: false });
    } catch (error) {
      this.logger.error('claim failed', error as Error);
      return failure(error);
    }
  }

  /** 1-based rank of the account's row for the day, or null when absent. */
  async rankOf(
    cruxId: string,
    day: string,
    accountId: string,
  ): Promise<RepositoryResponse<number | null>> {
    try {
      const r = (await this.dbService.query().raw(
        `SELECT rank FROM (
           SELECT account_id,
                  ROW_NUMBER() OVER (ORDER BY score DESC, seconds ASC, at ASC) AS rank
           FROM leaderboard_entries WHERE crux_id = ? AND day = ?
         ) ranked WHERE account_id = ?`,
        [cruxId, day, accountId],
      )) as { rows: { rank: string | number }[] };
      const row = r.rows?.[0];
      return success(row ? Number(row.rank) : null);
    } catch (error) {
      this.logger.error('rankOf failed', error as Error);
      return failure(error);
    }
  }
}
