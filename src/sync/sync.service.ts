import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  StoreService,
  isStoreObjectMissing,
} from '../common/services/store.service';
import { LoggerService } from '../common/services/logger.service';
import type { RepositoryResponse } from '../common/types/interfaces';
import { UsageService } from '../usage/usage.service';
import { LimitsService } from '../usage/limits.service';
import { NotificationsService } from '../usage/notifications.service';
import { AuthorService } from '../author/author.service';
import {
  SyncRepository,
  type SyncHead,
  type SyncUpload,
} from './sync.repository';
import { readBackupCatalog } from './sync-backup-catalog';

export interface GardenMeta {
  syncedAt: string;
  size: number;
}
export interface CruxIndexEntry {
  cruxId: string;
  slug: string;
  title: string;
  updatedAt: string;
  size: number;
}

/** SQL owns serving heads. Every upload has a distinct path and a durable intent. */
@Injectable()
export class SyncService {
  private readonly logger: LoggerService;
  private readonly bucket =
    process.env.AWS_S3_SYNC_BUCKET || 'sync.crux.garden';
  constructor(
    private readonly storeService: StoreService,
    loggerService: LoggerService,
    private readonly usage: UsageService,
    private readonly limits: LimitsService,
    private readonly authorService: AuthorService,
    private readonly notifications: NotificationsService,
    private readonly repo: SyncRepository,
  ) {
    this.logger = loggerService.createChildLogger('SyncService');
  }

  private value<T>(result: RepositoryResponse<T>): T | null {
    if (result.error)
      throw new ServiceUnavailableException('Sync metadata is unavailable');
    return result.data;
  }

  /** All admissions, head changes and metering share the same account transaction. */
  private locked<T>(
    accountId: string,
    work: () => Promise<T>,
    allowClosing = false,
  ): Promise<T> {
    return this.repo.forAccount(accountId, async () => {
      if (!allowClosing && this.value(await this.repo.closing(accountId)))
        throw new ConflictException('Account closure is in progress');
      if (!this.value(await this.repo.admitted(accountId))) {
        const heads = await readBackupCatalog(
          this.storeService,
          this.bucket,
          accountId,
        );
        this.value(await this.repo.admit(accountId, heads));
        for (const head of heads)
          await this.usage.recordSyncObject(
            accountId,
            head.kind,
            head.object_id,
            Number(head.size),
            head.title,
          );
      }
      return work();
    });
  }

  private async assertRoom(
    accountId: string,
    incoming: number,
    replacing: number,
    what: string,
  ): Promise<void> {
    let author;
    try {
      author = await this.authorService.findByAccountId(accountId);
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
    await this.limits.assertStorage(
      author.id,
      accountId,
      incoming,
      replacing,
      what,
    );
  }

  private async notifyAfterPush(accountId: string): Promise<void> {
    try {
      const author = await this.authorService.findByAccountId(accountId);
      await this.notifications.afterWrite(author.id, accountId);
    } catch (error) {
      if (!(error instanceof NotFoundException))
        this.logger.error(
          'Sync committed; usage notification failed',
          error as Error,
        );
    }
  }

  private async head(
    accountId: string,
    kind: SyncHead['kind'],
    objectId: string,
  ): Promise<SyncHead | null> {
    return this.value(await this.repo.head(accountId, kind, objectId));
  }

  private async push(
    accountId: string,
    kind: SyncHead['kind'],
    objectId: string,
    data: Buffer,
    meta: { slug: string | null; title: string },
  ): Promise<SyncHead> {
    // Reclaim known obsolete revisions before allowing another 500 MB upload.
    await this.cleanupRetired(accountId);
    const revisionId = randomUUID();
    const upload: SyncUpload = {
      account_id: accountId,
      kind,
      object_id: objectId,
      revision_id: revisionId,
      storage_path: `sync/${accountId}/revisions/${kind}/${objectId}/${revisionId}`,
      state: 'uploading',
    };
    const before = await this.locked(accountId, async () => {
      const previous = await this.head(accountId, kind, objectId);
      if (previous?.status === 'deleting')
        throw new ConflictException(
          'Backup deletion is in progress; retry deletion first',
        );
      const uploads = this.value(await this.repo.uploads(accountId)) ?? [];
      if (uploads.filter((item) => item.state === 'uploading').length >= 2)
        throw new ConflictException(
          'Two sync uploads are already pending; finish or reconcile them before uploading again',
        );
      await this.assertRoom(
        accountId,
        data.length,
        previous?.status === 'active' ? Number(previous.size) : 0,
        kind === 'garden' ? 'backup' : 'sync',
      );
      this.value(await this.repo.stage(upload));
      return previous;
    });
    // No database lock is held while the archive is uploaded. An uncertain store
    // failure retains the intent: deletion must not race a possibly unfinished PUT.
    try {
      await this.storeService.upload({
        path: upload.storage_path,
        namespace: this.bucket,
        data,
        contentType: 'application/zip',
      });
    } catch (error) {
      this.logger.error(
        'Sync upload outcome uncertain; reconcile retained intent before account cleanup',
        error as Error,
        { accountId, revisionId },
      );
      throw new ServiceUnavailableException(
        'Backup upload failed; the previous backup is unchanged',
      );
    }
    const next: SyncHead = {
      account_id: accountId,
      kind,
      object_id: objectId,
      revision_id: revisionId,
      storage_path: upload.storage_path,
      status: 'active',
      size: data.length,
      slug: meta.slug,
      title: meta.title,
      updated_at: new Date(),
    };
    try {
      await this.locked(accountId, async () => {
        const current = await this.head(accountId, kind, objectId);
        const intent = (
          this.value(await this.repo.uploads(accountId)) ?? []
        ).find((item) => item.revision_id === revisionId);
        if (
          intent?.state !== 'uploading' ||
          intent.storage_path !== upload.storage_path
        )
          throw new ConflictException(
            'Sync upload intent changed; refresh and retry',
          );
        if ((current?.revision_id ?? null) !== (before?.revision_id ?? null))
          throw new ConflictException(
            'Backup changed during upload; refresh and retry',
          );
        await this.assertRoom(
          accountId,
          data.length,
          current?.status === 'active' ? Number(current.size) : 0,
          kind === 'garden' ? 'backup' : 'sync',
        );
        // Keep the prior immutable object until this transaction actually commits.
        if (current?.storage_path) {
          const old: SyncUpload = {
            account_id: accountId,
            kind,
            object_id: objectId,
            revision_id: current.revision_id,
            storage_path: current.storage_path,
            state: 'retired',
          };
          const uploads = this.value(await this.repo.uploads(accountId)) ?? [];
          if (!uploads.some((item) => item.revision_id === old.revision_id))
            this.value(await this.repo.stage(old));
          else
            this.value(
              await this.repo.setUploadState(old.revision_id, 'retired'),
            );
        }
        this.value(await this.repo.save(next));
        this.value(await this.repo.setUploadState(revisionId, 'stored'));
        await this.usage.recordSyncObject(
          accountId,
          kind,
          objectId,
          data.length,
          meta.title,
        );
        await this.usage.recordTransfer(accountId, data.length, 0);
      });
    } catch (error) {
      // A lost COMMIT acknowledgement is not proof of rollback. Check the serving
      // head under the same lock before deciding whether our unique bytes are obsolete.
      const committed = await this.repo.forAccount(accountId, async () => {
        const current = await this.head(accountId, kind, objectId);
        if (current?.revision_id === revisionId) return true;
        this.value(await this.repo.setUploadState(revisionId, 'retired'));
        return false;
      });
      if (!committed) {
        await this.cleanupRetired(accountId);
        throw error;
      }
    }
    // Cleanup failure is recorded, not mistaken for failed activation. A subsequent
    // push refuses until cleanup succeeds, bounding retained previous revisions.
    await this.cleanupRetired(accountId).catch((error) =>
      this.logger.error(
        'Sync committed; obsolete revision cleanup requires retry',
        error as Error,
      ),
    );
    void this.notifyAfterPush(accountId);
    return next;
  }

  private gardenMeta(head: SyncHead): GardenMeta {
    return {
      syncedAt: new Date(head.updated_at).toISOString(),
      size: Number(head.size),
    };
  }
  private cruxEntry(head: SyncHead): CruxIndexEntry {
    return {
      cruxId: head.object_id,
      slug: head.slug!,
      title: head.title!,
      updatedAt: new Date(head.updated_at).toISOString(),
      size: Number(head.size),
    };
  }
  async pushGarden(accountId: string, data: Buffer): Promise<GardenMeta> {
    return this.gardenMeta(
      await this.push(accountId, 'garden', 'garden', data, {
        slug: null,
        title: 'Garden backup',
      }),
    );
  }
  async pushCrux(
    accountId: string,
    cruxId: string,
    data: Buffer,
    meta: { slug: string; title: string },
  ): Promise<CruxIndexEntry> {
    return this.cruxEntry(
      await this.push(accountId, 'crux', cruxId, data, meta),
    );
  }
  async getGardenStatus(accountId: string): Promise<GardenMeta | null> {
    return this.locked(accountId, async () => {
      const head = await this.head(accountId, 'garden', 'garden');
      return head?.status === 'active' ? this.gardenMeta(head) : null;
    });
  }
  async listCruxes(accountId: string): Promise<CruxIndexEntry[]> {
    return this.locked(accountId, async () =>
      (this.value(await this.repo.heads(accountId)) ?? [])
        .filter((head) => head.kind === 'crux' && head.status === 'active')
        .map((head) => this.cruxEntry(head)),
    );
  }
  private async pull(
    accountId: string,
    kind: SyncHead['kind'],
    objectId: string,
  ): Promise<Buffer> {
    let head = await this.locked(accountId, async () =>
      this.head(accountId, kind, objectId),
    );
    if (head?.status !== 'active')
      throw new NotFoundException('Synced backup not found');
    for (let attempt = 0; attempt < 2; attempt++) {
      let data: Buffer;
      try {
        data = (
          await this.storeService.download({
            path: head.storage_path!,
            namespace: this.bucket,
          })
        ).data;
      } catch (error) {
        if (attempt === 0 && isStoreObjectMissing(error)) {
          const current = await this.locked(accountId, async () =>
            this.head(accountId, kind, objectId),
          );
          if (
            current?.status === 'active' &&
            current.revision_id !== head.revision_id
          ) {
            head = current;
            continue;
          }
        }
        this.logger.error(
          'Referenced backup unavailable; serving head preserved',
          error as Error,
        );
        throw new ServiceUnavailableException(
          'Saved backup bytes are unavailable; retry or contact the operator',
        );
      }
      if (data.length !== Number(head.size))
        throw new ServiceUnavailableException(
          'Saved backup size does not match its metadata',
        );
      await this.usage.recordTransfer(accountId, 0, data.length);
      return data;
    }
    throw new ServiceUnavailableException(
      'Backup changed repeatedly during download; retry',
    );
  }

  pullGarden(accountId: string): Promise<Buffer> {
    return this.pull(accountId, 'garden', 'garden');
  }
  pullCrux(accountId: string, cruxId: string): Promise<Buffer> {
    return this.pull(accountId, 'crux', cruxId);
  }

  private async cleanupRetired(accountId: string): Promise<void> {
    const retired = await this.repo.forAccount(accountId, async () => {
      const heads = this.value(await this.repo.heads(accountId)) ?? [];
      return (this.value(await this.repo.uploads(accountId)) ?? []).filter(
        (upload) =>
          upload.state === 'retired' &&
          !heads.some(
            (head) =>
              head.status === 'active' &&
              head.storage_path === upload.storage_path,
          ),
      );
    });
    for (const upload of retired) {
      await this.storeService.delete({
        path: upload.storage_path,
        namespace: this.bucket,
      });
      await this.repo.forAccount(accountId, async () => {
        this.value(await this.repo.forgetUpload(upload.revision_id));
      });
    }
  }

  private async remove(
    accountId: string,
    kind: SyncHead['kind'],
    objectId: string,
    allowClosing = false,
  ): Promise<void> {
    const fence = await this.locked(
      accountId,
      async () => {
        const head = await this.head(accountId, kind, objectId);
        if (head?.status === 'deleting') return head;
        const deleting: SyncHead = {
          account_id: accountId,
          kind,
          object_id: objectId,
          revision_id: randomUUID(),
          status: 'deleting',
          storage_path: head?.storage_path ?? null,
          size: head?.size ?? 0,
          slug: head?.slug ?? null,
          title: head?.title ?? null,
          updated_at: new Date(),
        };
        this.value(await this.repo.save(deleting));
        return deleting;
      },
      allowClosing,
    );
    const pending = this.value(await this.repo.uploads(accountId)) ?? [];
    if (
      pending.some(
        (upload) =>
          upload.kind === kind &&
          upload.object_id === objectId &&
          upload.state === 'uploading',
      )
    )
      throw new ConflictException(
        'Backup deletion is waiting for a pending upload; retry after it finishes, or ask the operator to reconcile its intent',
      );
    await this.cleanupRetired(accountId);
    if (fence.storage_path)
      await this.storeService.delete({
        path: fence.storage_path,
        namespace: this.bucket,
      });
    // Current-format catalogs are never read again after admission. Remove only
    // the superseded Garden metadata; the Crux catalog is retained until account cleanup.
    if (kind === 'garden')
      await this.storeService.delete({
        path: `sync/${accountId}/garden-meta.json`,
        namespace: this.bucket,
      });
    await this.locked(
      accountId,
      async () => {
        const current = await this.head(accountId, kind, objectId);
        if (current?.revision_id !== fence.revision_id)
          throw new ConflictException('Deletion fence changed');
        if (current.status === 'deleted') return;
        this.value(
          await this.repo.save({
            ...fence,
            status: 'deleted',
            storage_path: null,
            size: 0,
          }),
        );
        for (const upload of this.value(await this.repo.uploads(accountId)) ??
          [])
          if (upload.kind === kind && upload.object_id === objectId)
            this.value(await this.repo.forgetUpload(upload.revision_id));
        await this.usage.clearSyncObject(accountId, kind, objectId);
      },
      allowClosing,
    );
  }
  deleteGarden(accountId: string): Promise<void> {
    return this.remove(accountId, 'garden', 'garden');
  }
  deleteCrux(accountId: string, cruxId: string): Promise<void> {
    return this.remove(accountId, 'crux', cruxId);
  }
}
