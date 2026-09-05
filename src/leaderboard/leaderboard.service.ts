import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { LoggerService } from '../common/services/logger.service';
import { CruxService } from '../crux/crux.service';
import { AuthorService } from '../author/author.service';
import {
  LeaderboardRepository,
  type LeaderboardRow,
} from './leaderboard.repository';

export interface LeaderboardEntry {
  name: string;
  score: number;
  seconds: number;
  at: string;
}
export interface LeaderboardView {
  day: string;
  entries: LeaderboardEntry[];
  /** the caller's place, when signed in and on the board */
  you: {
    rank: number;
    score: number;
    seconds: number;
    counted: boolean;
  } | null;
}

/** Max points in a round (5Ws: ten to start, a wrong guess costs one). */
export const MAX_SCORE = 10;
/** Round budget in seconds; anything longer is not a real round. */
export const MAX_SECONDS = 5 * 60 + 30;
const BOARD_SIZE = 50;

/** 'today' or YYYY-MM-DD (UTC). Anything else is a 400. */
export function resolveDay(input: string, now = new Date()): string {
  if (input === 'today') return now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(Date.parse(input)))
    throw new BadRequestException('day must be YYYY-MM-DD or "today"');
  return input;
}

@Injectable()
export class LeaderboardService {
  private readonly logger: LoggerService;

  constructor(
    private readonly repo: LeaderboardRepository,
    private readonly cruxService: CruxService,
    private readonly authorService: AuthorService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('LeaderboardService');
  }

  /** Public: anyone may read a shelf's board for a day. */
  async board(
    cruxId: string,
    dayInput: string,
    accountId: string | null,
  ): Promise<LeaderboardView> {
    const day = resolveDay(dayInput);
    const crux = await this.cruxService.findById(cruxId);
    if (!crux) throw new NotFoundException('Crux not found');
    const rows = await this.repo.forDay(cruxId, day, BOARD_SIZE);
    if (rows.error)
      throw new InternalServerErrorException('Leaderboard unavailable');
    return {
      day,
      entries: rows.data!.map(view),
      you: accountId ? await this.placeOf(cruxId, day, accountId) : null,
    };
  }

  /**
   * Signed in only: record the caller's first round of the day. A repeat post
   * returns the standing entry with `counted: false` — practice, by design.
   */
  async post(
    cruxId: string,
    dayInput: string,
    accountId: string,
    score: number,
    seconds: number,
  ): Promise<LeaderboardView> {
    const day = resolveDay(dayInput);
    if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE)
      throw new BadRequestException(`score must be an integer 0..${MAX_SCORE}`);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SECONDS)
      throw new BadRequestException(
        `seconds must be an integer 0..${MAX_SECONDS}`,
      );
    const crux = await this.cruxService.findById(cruxId);
    if (!crux) throw new NotFoundException('Crux not found');
    const author = await this.authorService.findByAccountId(accountId);
    if (!author) throw new NotFoundException('Author not found');
    const claimed = await this.repo.claim({
      crux_id: cruxId,
      day,
      account_id: accountId,
      name: author.username,
      score,
      seconds,
    });
    if (claimed.error || !claimed.data)
      throw new InternalServerErrorException('Leaderboard unavailable');
    this.logger.info('Leaderboard entry', {
      cruxId,
      day,
      accountId,
      counted: claimed.data.inserted,
    });
    const rows = await this.repo.forDay(cruxId, day, BOARD_SIZE);
    const place = await this.placeOf(cruxId, day, accountId);
    return {
      day,
      entries: (rows.data ?? []).map(view),
      you: place ? { ...place, counted: claimed.data.inserted } : null,
    };
  }

  private async placeOf(cruxId: string, day: string, accountId: string) {
    const rank = (await this.repo.rankOf(cruxId, day, accountId)).data;
    if (!rank) return null;
    const rows = (await this.repo.forDay(cruxId, day, BOARD_SIZE)).data ?? [];
    const mine = rows.find((r) => r.account_id === accountId);
    return {
      rank,
      score: mine?.score ?? 0,
      seconds: mine?.seconds ?? 0,
      counted: true,
    };
  }
}

function view(r: LeaderboardRow): LeaderboardEntry {
  return {
    name: r.name,
    score: r.score,
    seconds: r.seconds,
    at: new Date(r.at).toISOString(),
  };
}
