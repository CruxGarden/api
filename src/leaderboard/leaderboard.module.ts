import { Module, forwardRef } from '@nestjs/common';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardRepository } from './leaderboard.repository';
import { CruxModule } from '../crux/crux.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [forwardRef(() => CruxModule), forwardRef(() => AuthorModule)],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardRepository],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
