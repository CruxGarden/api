import { SyncStorageModule } from './sync-storage.module';
import { Module, forwardRef } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { CommonModule } from '../common/common.module';
import { UsageModule } from '../usage/usage.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [
    CommonModule,
    SyncStorageModule,
    forwardRef(() => UsageModule),
    forwardRef(() => AuthorModule),
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
