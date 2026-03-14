import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DiscoverController } from './discover.controller';
import { DiscoverService } from './discover.service';
import { DiscoverRepository } from './discover.repository';

@Module({
  imports: [CommonModule],
  controllers: [DiscoverController],
  providers: [DiscoverService, DiscoverRepository],
})
export class DiscoverModule {}
