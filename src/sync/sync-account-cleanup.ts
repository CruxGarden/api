import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StoreService } from '../common/services/store.service';
import type { RepositoryResponse } from '../common/types/interfaces';
import { SyncRepository } from './sync.repository';

/** Teardown uses the same account fence and intent ledger as normal sync.
 * It has no dependency on publishing, authors or billing provider callbacks.
 */
@Injectable()
export class SyncAccountCleanup {
  constructor(
    private readonly repo: SyncRepository,
    private readonly store: StoreService,
  ) {}
  private value<T>(result: RepositoryResponse<T>): T | null {
    if (result.error)
      throw new ServiceUnavailableException(
        'Sync cleanup metadata is unavailable',
      );
    return result.data;
  }
  async closeAccount(accountId: string): Promise<void> {
    await this.repo.forAccount(accountId, async () => {
      if (!this.value(await this.repo.closing(accountId)))
        throw new ConflictException(
          'Account closure must be fenced before sync cleanup',
        );
      if (
        (this.value(await this.repo.uploads(accountId)) ?? []).some(
          (upload) => upload.state === 'uploading',
        )
      )
        throw new ConflictException(
          'Account cleanup is waiting for pending sync uploads; finish or reconcile them first',
        );
    });
    // Closure prevents new stages and activation. No database lock is held while
    // storage is removed. Preserve metadata and usage if any physical cleanup fails.
    await this.store.deleteByPrefix({
      prefix: `sync/${accountId}/`,
      namespace: process.env.AWS_S3_SYNC_BUCKET || 'sync.crux.garden',
    });
    await this.repo.forAccount(accountId, async () => {
      this.value(await this.repo.completeAccountCleanup(accountId));
    });
  }
}
