import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { SyncRepository } from './sync.repository';
import { SyncAccountCleanup } from './sync-account-cleanup';

/** Storage ownership can be used by teardown without importing interactive sync or authors. */
@Module({
  imports: [CommonModule],
  providers: [SyncRepository, SyncAccountCleanup],
  exports: [SyncRepository, SyncAccountCleanup],
})
export class SyncStorageModule {}
