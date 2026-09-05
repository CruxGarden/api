import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { AuthGuard } from '../common/guards/auth.guard';
import { OptionalAuthGuard } from '../common/guards/optional-auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import {
  LeaderboardService,
  type LeaderboardView,
  MAX_SCORE,
  MAX_SECONDS,
} from './leaderboard.service';

export class PostScoreDto {
  @ApiProperty({
    minimum: 0,
    maximum: MAX_SCORE,
    description: 'Points left at the end of the round',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_SCORE)
  score!: number;

  @ApiProperty({
    minimum: 0,
    maximum: MAX_SECONDS,
    description: 'Round duration in seconds',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_SECONDS)
  seconds!: number;
}

/**
 * 5Ws daily leaderboards: one board per Shelf (crux) per UTC day. Reading is
 * public — a published shelf page shows today's board; writing needs an
 * account, and only the first round of the day counts.
 */
@ApiTags('leaderboard')
@Controller('cruxes/:cruxId/leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get(':day')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "A shelf's board for a day ('today' or YYYY-MM-DD)",
  })
  board(
    @Param('cruxId', ParseUUIDPipe) cruxId: string,
    @Param('day') day: string,
    @Req() req: AuthRequest,
  ): Promise<LeaderboardView> {
    return this.leaderboard.board(cruxId, day, req.account?.id ?? null);
  }

  @Post(':day')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Record the caller's first round of the day" })
  post(
    @Param('cruxId', ParseUUIDPipe) cruxId: string,
    @Param('day') day: string,
    @Body() body: PostScoreDto,
    @Req() req: AuthRequest,
  ): Promise<LeaderboardView> {
    return this.leaderboard.post(
      cruxId,
      day,
      req.account.id,
      body.score,
      body.seconds,
    );
  }
}
