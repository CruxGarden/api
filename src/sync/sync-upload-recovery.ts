import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RepositoryResponse } from '../common/types/interfaces';
import { StoreService } from '../common/services/store.service';
import { SyncRepository } from './sync.repository';

/** Offline operator maintenance only, deliberately not registered as an HTTP service.
 * The operator must drain ALL API writers and resolve outstanding provider writes.
 * Age alone never proves an upload has stopped. See ADR 0072 and the handoff runbook.
 */
export class SyncUploadRecovery {
  constructor(
    private readonly repo: SyncRepository,
    private readonly store: StoreService,
  ) {}
  private value<T>(result: RepositoryResponse<T>): T | null {
    if (result.error)
      throw new ServiceUnavailableException(
        'Sync recovery metadata is unavailable',
      );
    return result.data;
  }
  async inspect(accountId: string, revisionId: string) {
    return this.repo.forAccount(accountId, async () => {
      const upload = (
        this.value(await this.repo.uploads(accountId)) ?? []
      ).find((item) => item.revision_id === revisionId);
      if (!upload) throw new NotFoundException('Upload intent not found');
      const referenced = (
        this.value(await this.repo.heads(accountId)) ?? []
      ).some(
        (head) =>
          head.storage_path === upload.storage_path &&
          head.status !== 'deleted',
      );
      return { upload, referenced };
    });
  }
  async retire(
    accountId: string,
    revisionId: string,
    options: { writerDrainConfirmed: boolean; reason: string },
  ): Promise<void> {
    if (
      !options.writerDrainConfirmed ||
      options.reason.trim().length < 8 ||
      options.reason.length > 500
    )
      throw new ConflictException(
        'Confirm all writers and provider writes have stopped and provide an audit reason (8–500 characters)',
      );
    const upload = await this.repo.forAccount(accountId, async () => {
      const { upload, referenced } = await this.inspect(accountId, revisionId);
      if (referenced || upload.state === 'stored')
        throw new ConflictException(
          'A committed or deleting backup cannot be retired by upload recovery',
        );
      this.value(await this.repo.recordRecovery(upload, options.reason.trim()));
      this.value(await this.repo.setUploadState(revisionId, 'retired'));
      return upload;
    });
    // Durable retired intent + audit precede external deletion; refusal is retryable.
    await this.store.delete({
      namespace: process.env.AWS_S3_SYNC_BUCKET || 'sync.crux.garden',
      path: upload.storage_path,
    });
    await this.repo.forAccount(accountId, async () => {
      this.value(await this.repo.forgetUpload(revisionId));
    });
  }
}
