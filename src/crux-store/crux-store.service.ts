import {
  Injectable,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { toEntityFields } from '../common/helpers/case-helpers';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { StoreRepository } from './crux-store.repository';
import StoreRaw from './entities/crux-store-raw.entity';
import Store from './entities/crux-store.entity';

@Injectable()
export class StoreService {
  private readonly logger: LoggerService;

  constructor(
    private readonly repository: StoreRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('StoreService');
  }

  asStore(data: StoreRaw): Store {
    const fields = toEntityFields(data);
    return new Store(fields);
  }

  async get(
    cruxId: string,
    key: string,
    visitorId?: string | null,
  ): Promise<Store | null> {
    // Try protected (per-visitor) first if visitor is authenticated
    if (visitorId) {
      const { data } = await this.repository.findProtectedEntry(
        cruxId,
        key,
        visitorId,
      );
      if (data) return this.asStore(data);
    }

    // Fall back to public
    const { data } = await this.repository.findPublicEntry(cruxId, key);
    return data ? this.asStore(data) : null;
  }

  async set(
    cruxId: string,
    authorId: string,
    key: string,
    value: any,
    mode: 'public' | 'protected' = 'protected',
    visitorId?: string | null,
  ): Promise<Store> {
    const id = this.keyMaster.generateId();

    this.logger.debug(`Store set: ${key} (${mode})`, { cruxId });

    if (mode === 'public') {
      const { data, error } = await this.repository.upsertPublic(
        id,
        cruxId,
        authorId,
        key,
        value,
      );
      if (error || !data) {
        throw new InternalServerErrorException(`Store set failed: ${error}`);
      }
      return this.asStore(data);
    }

    if (!visitorId) {
      throw new ForbiddenException('Protected keys require authentication');
    }

    const { data, error } = await this.repository.upsertProtected(
      id,
      cruxId,
      authorId,
      visitorId,
      key,
      value,
    );
    if (error || !data) {
      throw new InternalServerErrorException(`Store set failed: ${error}`);
    }
    return this.asStore(data);
  }

  async increment(
    cruxId: string,
    authorId: string,
    key: string,
    by: number = 1,
    visitorId?: string | null,
  ): Promise<number> {
    // Check if entry exists
    const existing = visitorId
      ? await this.repository.findProtectedEntry(cruxId, key, visitorId)
      : await this.repository.findPublicEntry(cruxId, key);

    if (!existing.data) {
      // Create with initial value
      const mode = visitorId ? 'protected' : 'public';
      await this.set(cruxId, authorId, key, by, mode as any, visitorId);
      return by;
    }

    const { data, error } = await this.repository.atomicIncrement(
      cruxId,
      key,
      by,
      visitorId,
    );
    if (error || !data) {
      throw new InternalServerErrorException(
        `Store increment failed: ${error}`,
      );
    }
    return typeof data.value === 'number' ? data.value : Number(data.value);
  }

  async delete(
    cruxId: string,
    key: string,
    visitorId?: string | null,
  ): Promise<void> {
    const { error } = await this.repository.deleteEntry(cruxId, key, visitorId);
    if (error) {
      throw new InternalServerErrorException(`Store delete failed: ${error}`);
    }
  }

  async list(cruxId: string): Promise<Store[]> {
    const { data, error } = await this.repository.findAllByCrux(cruxId);
    if (error) {
      throw new InternalServerErrorException(`Store list failed: ${error}`);
    }
    return (data || []).map((row) => this.asStore(row));
  }

  async clearAll(cruxId: string): Promise<void> {
    const { error } = await this.repository.clearAllByCrux(cruxId);
    if (error) {
      throw new InternalServerErrorException(`Store clear failed: ${error}`);
    }
  }

  async getStorageBytes(authorId: string): Promise<number> {
    const { data, error } = await this.repository.getStorageByAuthor(authorId);
    if (error) {
      throw new InternalServerErrorException(`Storage query failed: ${error}`);
    }
    return data || 0;
  }
}
