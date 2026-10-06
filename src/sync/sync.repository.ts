import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { accountTransaction } from '../common/helpers/account-transaction';
import { success, failure } from '../common/helpers/repository-helpers';
import type { RepositoryResponse } from '../common/types/interfaces';

export interface SyncHead {
  account_id: string;
  kind: 'garden' | 'crux';
  object_id: string;
  revision_id: string;
  status: 'active' | 'deleting' | 'deleted';
  storage_path: string | null;
  size: number | string;
  slug: string | null;
  title: string | null;
  updated_at: Date | string;
}

export interface SyncUpload {
  revision_id: string;
  account_id: string;
  kind: SyncHead['kind'];
  object_id: string;
  storage_path: string;
  state: 'uploading' | 'stored' | 'retired';
}

/** The committed serving pointer and deletion fence; storage never chooses a head. */
@Injectable()
export class SyncRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly db: DbService,
    logger: LoggerService,
  ) {
    this.logger = logger.createChildLogger('SyncRepository');
  }
  forAccount<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    return accountTransaction(this.db, accountId, work);
  }
  private async result<T>(
    work: () => Promise<T>,
  ): Promise<RepositoryResponse<T>> {
    try {
      return success(await work());
    } catch (error) {
      this.logger.error('Sync metadata unavailable', error as Error);
      return failure(error);
    }
  }
  admitted(accountId: string) {
    return this.result(
      async () =>
        !!(await this.db
          .query()('sync_account_state')
          .where({ account_id: accountId })
          .first('account_id')),
    );
  }
  closing(accountId: string) {
    return this.result(
      async () =>
        !!(
          await this.db
            .query()('billing_account_state')
            .where({ account_id: accountId })
            .first('closing_at')
        )?.closing_at,
    );
  }
  /** Call under the account lock, once, after validating current-format backups. */
  admit(accountId: string, heads: SyncHead[]) {
    return this.result(async () => {
      if (heads.length) await this.db.query()('sync_heads').insert(heads);
      await this.db
        .query()('sync_account_state')
        .insert({ account_id: accountId });
    });
  }
  heads(accountId: string): Promise<RepositoryResponse<SyncHead[]>> {
    return this.result(() =>
      this.db
        .query()('sync_heads')
        .where({ account_id: accountId })
        .select('*'),
    );
  }
  head(
    accountId: string,
    kind: SyncHead['kind'],
    objectId: string,
  ): Promise<RepositoryResponse<SyncHead | null>> {
    return this.result(
      async () =>
        (await this.db
          .query()('sync_heads')
          .where({ account_id: accountId, kind, object_id: objectId })
          .first()) ?? null,
    );
  }
  save(head: SyncHead): Promise<RepositoryResponse<void>> {
    return this.result(async () => {
      await this.db
        .query()('sync_heads')
        .insert(head)
        .onConflict(['account_id', 'kind', 'object_id'])
        .merge(head);
    });
  }
  uploads(accountId: string): Promise<RepositoryResponse<SyncUpload[]>> {
    return this.result(() =>
      this.db
        .query()('sync_uploads')
        .where({ account_id: accountId })
        .select('*'),
    );
  }
  stage(upload: SyncUpload): Promise<RepositoryResponse<void>> {
    return this.result(async () => {
      await this.db.query()('sync_uploads').insert(upload);
    });
  }
  setUploadState(
    revisionId: string,
    state: SyncUpload['state'],
  ): Promise<RepositoryResponse<void>> {
    return this.result(async () => {
      const updated = await this.db
        .query()('sync_uploads')
        .where({ revision_id: revisionId })
        .modify((query) => {
          if (state === 'stored') query.where({ state: 'uploading' });
        })
        .update({ state });
      if (updated !== 1)
        throw new Error('Sync upload intent is missing or already changed');
    });
  }
  forgetUpload(revisionId: string): Promise<RepositoryResponse<void>> {
    return this.result(async () => {
      await this.db
        .query()('sync_uploads')
        .where({ revision_id: revisionId })
        .delete();
    });
  }
  completeAccountCleanup(accountId: string): Promise<RepositoryResponse<void>> {
    return this.result(async () => {
      await this.db
        .query()('sync_heads')
        .where({ account_id: accountId })
        .update({ status: 'deleted', storage_path: null, size: 0 });
      await this.db
        .query()('sync_uploads')
        .where({ account_id: accountId })
        .delete();
      await this.db
        .query()('usage_sync_objects')
        .where({ account_id: accountId })
        .delete();
    });
  }
  recordRecovery(
    upload: SyncUpload,
    reason: string,
  ): Promise<RepositoryResponse<void>> {
    return this.result(async () => {
      await this.db
        .query()('sync_recoveries')
        .insert({
          revision_id: upload.revision_id,
          account_id: upload.account_id,
          storage_path: upload.storage_path,
          reason,
        })
        .onConflict('revision_id')
        .ignore();
    });
  }
}
