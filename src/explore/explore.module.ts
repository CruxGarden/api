import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';
import { ExploreRepository } from './explore.repository';

@Module({
  imports: [CommonModule],
  controllers: [ExploreController],
  providers: [ExploreService, ExploreRepository],
})
export class ExploreModule {}
