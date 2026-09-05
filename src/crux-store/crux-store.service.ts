import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { toEntityFields } from '../common/helpers/case-helpers';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { StoreRepository } from './crux-store.repository';
import StoreRaw from './entities/crux-store-raw.entity';
import Store, { StoreMode } from './entities/crux-store.entity';

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

  // ── Mode resolution ─────────────────────────────────────

  /**
   * The modes a key's rows carry. Empty for a key never written. A key has
   * one mode; two can only be legacy `public` + `protected` data.
   */
  private async keyModes(cruxId: string, key: string): Promise<StoreMode[]> {
    const { data, error } = await this.repository.findKeyModes(cruxId, key);
    if (error) {
      throw new InternalServerErrorException(`Store lookup failed: ${error}`);
    }
    return data ?? [];
  }

  /**
   * A key's mode is fixed by its first write. A later write naming a
   * different mode is refused — otherwise a writer could, say, reopen a
   * token-gated `common` key as `public`.
   */
  private assertModeAllowed(
    key: string,
    modes: StoreMode[],
    requested: StoreMode,
  ): void {
    if (modes.length === 0 || modes.includes(requested)) return;
    throw new ConflictException(
      `Key "${key}" is ${modes[0]}; it cannot be written as ${requested}`,
    );
  }

  /** The mode an existing key resolves to for this caller. */
  private resolveMode(
    modes: StoreMode[],
    visitorId: string | null | undefined,
  ): StoreMode {
    if (modes.length === 1) return modes[0];
    if (modes.includes('common')) return 'common';
    // Legacy key with both a public value and protected slots.
    return visitorId ? 'protected' : 'public';
  }

  private requireVisitor(
    mode: StoreMode,
    visitorId: string | null | undefined,
  ): string {
    if (visitorId) return visitorId;
    if (mode === 'common') {
      throw new UnauthorizedException(
        'Common keys require a signed-in account to write',
      );
    }
    throw new UnauthorizedException('Protected keys require authentication');
  }

  // ── Reads ───────────────────────────────────────────────

  /**
   * Read a key: the caller's own protected slot if signed in, else the shared
   * value (`public` or `common` — both readable by anyone), else null.
   */
  async get(
    cruxId: string,
    key: string,
    visitorId?: string | null,
  ): Promise<Store | null> {
    if (visitorId) {
      const { data } = await this.repository.findProtectedEntry(
        cruxId,
        key,
        visitorId,
      );
      if (data) return this.asStore(data);
    }

    const { data } = await this.repository.findSharedEntry(cruxId, key);
    return data ? this.asStore(data) : null;
  }

  // ── Writes ──────────────────────────────────────────────

  async set(
    cruxId: string,
    authorId: string,
    key: string,
    value: any,
    mode: StoreMode = 'protected',
    visitorId?: string | null,
  ): Promise<Store> {
    const modes = await this.keyModes(cruxId, key);
    this.assertModeAllowed(key, modes, mode);
    return this.write(cruxId, authorId, key, value, mode, visitorId);
  }

  /** Upsert without the mode check — callers have already resolved the mode. */
  private async write(
    cruxId: string,
    authorId: string,
    key: string,
    value: any,
    mode: StoreMode,
    visitorId?: string | null,
  ): Promise<Store> {
    const id = this.keyMaster.generateId();
    this.logger.debug(`Store set: ${key} (${mode})`, { cruxId });

    if (mode === 'protected') {
      const slot = this.requireVisitor(mode, visitorId);
      const { data, error } = await this.repository.upsertProtected(
        id,
        cruxId,
        authorId,
        slot,
        key,
        value,
      );
      if (error || !data) {
        throw new InternalServerErrorException(`Store set failed: ${error}`);
      }
      return this.asStore(data);
    }

    if (mode === 'common') this.requireVisitor(mode, visitorId);
    const { data, error } = await this.repository.upsertShared(
      id,
      cruxId,
      authorId,
      key,
      value,
      mode,
    );
    if (error || !data) {
      throw new InternalServerErrorException(`Store set failed: ${error}`);
    }
    return this.asStore(data);
  }

  /**
   * Atomic increment. `public` and `common` increment the shared value
   * (`common` needs a signed-in caller); `protected` increments the caller's
   * own slot. A missing value is created at `by`. A key that does not exist
   * yet is created in `requestedMode`, else `protected` when signed in and
   * `public` otherwise.
   */
  async increment(
    cruxId: string,
    authorId: string,
    key: string,
    by: number = 1,
    visitorId?: string | null,
    requestedMode?: StoreMode,
  ): Promise<number> {
    const modes = await this.keyModes(cruxId, key);
    if (requestedMode) this.assertModeAllowed(key, modes, requestedMode);

    const mode: StoreMode =
      modes.length === 0
        ? (requestedMode ?? (visitorId ? 'protected' : 'public'))
        : this.resolveMode(modes, visitorId);

    let slot: string | null = null;
    if (mode === 'protected') slot = this.requireVisitor(mode, visitorId);
    else if (mode === 'common') this.requireVisitor(mode, visitorId);

    const existing = slot
      ? await this.repository.findProtectedEntry(cruxId, key, slot)
      : await this.repository.findSharedEntry(cruxId, key);

    if (!existing.data) {
      await this.write(cruxId, authorId, key, by, mode, visitorId);
      return by;
    }

    const { data, error } = await this.repository.atomicIncrement(
      cruxId,
      key,
      by,
      slot,
    );
    if (error || !data) {
      throw new InternalServerErrorException(
        `Store increment failed: ${error}`,
      );
    }
    return typeof data.value === 'number' ? data.value : Number(data.value);
  }

  /**
   * A visitor's delete: the shared value of a `public` key (anyone) or a
   * `common` key (signed-in required), or the caller's own slot on a
   * `protected` key. A key that does not exist is a no-op.
   */
  async deleteSlot(
    cruxId: string,
    key: string,
    visitorId?: string | null,
  ): Promise<void> {
    const modes = await this.keyModes(cruxId, key);
    if (modes.length === 0) return;

    const mode = this.resolveMode(modes, visitorId);
    let slot: string | null = null;
    if (mode === 'protected') slot = this.requireVisitor(mode, visitorId);
    else if (mode === 'common') this.requireVisitor(mode, visitorId);

    const { error } = await this.repository.deleteEntry(cruxId, key, slot);
    if (error) {
      throw new InternalServerErrorException(`Store delete failed: ${error}`);
    }
  }

  /** The author's delete: every row of the key, all slots included. */
  async delete(cruxId: string, key: string): Promise<void> {
    const { error } = await this.repository.deleteKey(cruxId, key);
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
