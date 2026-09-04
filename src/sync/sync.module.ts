import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { CommonModule } from '../common/common.module';
import { UsageModule } from '../usage/usage.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [CommonModule, UsageModule, AuthorModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
