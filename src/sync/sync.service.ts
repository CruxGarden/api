import { Injectable, NotFoundException } from '@nestjs/common';
import { StoreService } from '../common/services/store.service';
import { LoggerService } from '../common/services/logger.service';

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

@Injectable()
export class SyncService {
  private readonly logger: LoggerService;
  private readonly bucket =
    process.env.AWS_S3_SYNC_BUCKET || 'sync.crux.garden';

  constructor(
    private readonly storeService: StoreService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('SyncService');
  }

  private gardenPath(accountId: string): string {
    return `sync/${accountId}/garden.zip`;
  }

  private gardenMetaPath(accountId: string): string {
    return `sync/${accountId}/garden-meta.json`;
  }

  private cruxPath(accountId: string, cruxId: string): string {
    return `sync/${accountId}/cruxes/${cruxId}.crux`;
  }

  private cruxIndexPath(accountId: string): string {
    return `sync/${accountId}/cruxes/_index.json`;
  }

  // --- Garden ---

  async pushGarden(accountId: string, data: Buffer): Promise<GardenMeta> {
    const meta: GardenMeta = {
      syncedAt: new Date().toISOString(),
      size: data.length,
    };

    await this.storeService.upload({
      path: this.gardenPath(accountId),
      data,
      namespace: this.bucket,
      contentType: 'application/zip',
    });

    await this.storeService.upload({
      path: this.gardenMetaPath(accountId),
      data: Buffer.from(JSON.stringify(meta)),
      namespace: this.bucket,
      contentType: 'application/json',
    });

    this.logger.info('Garden pushed', { accountId, size: meta.size });
    return meta;
  }

  async pullGarden(accountId: string): Promise<Buffer> {
    try {
      const result = await this.storeService.download({
        path: this.gardenPath(accountId),
        namespace: this.bucket,
      });
      return result.data;
    } catch (e) {
      this.logger.warn('Garden download failed', {
        accountId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new NotFoundException('No garden backup found');
    }
  }

  async getGardenStatus(accountId: string): Promise<GardenMeta | null> {
    try {
      const result = await this.storeService.download({
        path: this.gardenMetaPath(accountId),
        namespace: this.bucket,
      });
      return JSON.parse(result.data.toString());
    } catch {
      return null;
    }
  }

  // --- Crux ---

  async pushCrux(
    accountId: string,
    cruxId: string,
    data: Buffer,
    meta: { slug: string; title: string },
  ): Promise<CruxIndexEntry> {
    const entry: CruxIndexEntry = {
      cruxId,
      slug: meta.slug,
      title: meta.title,
      updatedAt: new Date().toISOString(),
      size: data.length,
    };

    await this.storeService.upload({
      path: this.cruxPath(accountId, cruxId),
      data,
      namespace: this.bucket,
      contentType: 'application/zip',
    });

    // Update index
    const index = await this.loadCruxIndex(accountId);
    const existing = index.findIndex((e) => e.cruxId === cruxId);
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }
    await this.saveCruxIndex(accountId, index);

    this.logger.info('Crux pushed', { accountId, cruxId, size: entry.size });
    return entry;
  }

  async pullCrux(accountId: string, cruxId: string): Promise<Buffer> {
    try {
      const result = await this.storeService.download({
        path: this.cruxPath(accountId, cruxId),
        namespace: this.bucket,
      });
      return result.data;
    } catch (e) {
      this.logger.warn('Crux download failed', {
        accountId,
        cruxId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new NotFoundException('Synced crux not found');
    }
  }

  async listCruxes(accountId: string): Promise<CruxIndexEntry[]> {
    return this.loadCruxIndex(accountId);
  }

  async deleteCrux(accountId: string, cruxId: string): Promise<void> {
    // Update index first — orphaned files are less harmful than dangling pointers
    const index = await this.loadCruxIndex(accountId);
    const updated = index.filter((e) => e.cruxId !== cruxId);
    await this.saveCruxIndex(accountId, updated);

    await this.storeService.delete({
      path: this.cruxPath(accountId, cruxId),
      namespace: this.bucket,
    });

    this.logger.info('Crux deleted from sync', { accountId, cruxId });
  }

  // --- Index helpers ---

  private async loadCruxIndex(accountId: string): Promise<CruxIndexEntry[]> {
    try {
      const result = await this.storeService.download({
        path: this.cruxIndexPath(accountId),
        namespace: this.bucket,
      });
      return JSON.parse(result.data.toString());
    } catch {
      return [];
    }
  }

  private async saveCruxIndex(
    accountId: string,
    index: CruxIndexEntry[],
  ): Promise<void> {
    await this.storeService.upload({
      path: this.cruxIndexPath(accountId),
      data: Buffer.from(JSON.stringify(index)),
      namespace: this.bucket,
      contentType: 'application/json',
    });
  }
}
