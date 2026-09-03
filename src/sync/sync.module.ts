import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { CommonModule } from '../common/common.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [CommonModule, UsageModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
