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
import Store, {
  normalizeStoreMode,
  StoreMode,
} from './entities/crux-store.entity';

/** The one refusal every unsigned write gets, whatever the key's mode. */
export const STORE_WRITE_NEEDS_ACCOUNT =
  'Writing to the store requires a signed-in account';

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
    return new Store({
      ...fields,
      mode: normalizeStoreMode(String(fields.mode)) as StoreMode,
    });
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
   * different mode is refused — otherwise a writer could, say, turn a
   * private `protected` key into a shared `public` one.
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

  /** The mode an existing key resolves to. */
  private resolveMode(modes: StoreMode[]): StoreMode {
    if (modes.length === 1) return modes[0];
    // Legacy key with both a public value and protected slots: the writer is
    // always signed in now, so their own slot is what they mean.
    return 'protected';
  }

  /**
   * Every write needs a signed-in account: with no anonymous writes there is
   * no anonymous abuse — it is one username, and it can be stopped.
   */
  private requireWriter(visitorId: string | null | undefined): string {
    if (visitorId) return visitorId;
    throw new UnauthorizedException(STORE_WRITE_NEEDS_ACCOUNT);
  }

  // ── Reads ───────────────────────────────────────────────

  /**
   * Read a key: the caller's own protected slot if signed in, else the shared
   * value of a `public` key (readable by anyone), else null.
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
    const writer = this.requireWriter(visitorId);
    const requested = normalizeStoreMode(mode) as StoreMode;
    const modes = await this.keyModes(cruxId, key);
    this.assertModeAllowed(key, modes, requested);
    return this.write(cruxId, authorId, key, value, requested, writer);
  }

  /** Upsert without the mode or sign-in checks — callers have done both. */
  private async write(
    cruxId: string,
    authorId: string,
    key: string,
    value: any,
    mode: StoreMode,
    writer: string,
  ): Promise<Store> {
    const id = this.keyMaster.generateId();
    this.logger.debug(`Store set: ${key} (${mode})`, { cruxId });

    const { data, error } =
      mode === 'protected'
        ? await this.repository.upsertProtected(
            id,
            cruxId,
            authorId,
            writer,
            key,
            value,
          )
        : await this.repository.upsertShared(
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
   * Atomic increment by a signed-in caller. `public` increments the shared
   * value; `protected` increments the caller's own slot. A missing value is
   * created at `by`. A key that does not exist yet is created in
   * `requestedMode`, else `protected`.
   */
  async increment(
    cruxId: string,
    authorId: string,
    key: string,
    by: number = 1,
    visitorId?: string | null,
    requestedMode?: StoreMode,
  ): Promise<number> {
    const writer = this.requireWriter(visitorId);
    const requested = requestedMode
      ? (normalizeStoreMode(requestedMode) as StoreMode)
      : undefined;
    const modes = await this.keyModes(cruxId, key);
    if (requested) this.assertModeAllowed(key, modes, requested);

    const mode: StoreMode =
      modes.length === 0 ? (requested ?? 'protected') : this.resolveMode(modes);
    const slot = mode === 'protected' ? writer : null;

    const existing = slot
      ? await this.repository.findProtectedEntry(cruxId, key, slot)
      : await this.repository.findSharedEntry(cruxId, key);

    if (!existing.data) {
      await this.write(cruxId, authorId, key, by, mode, writer);
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
   * A signed-in visitor's delete: the shared value of a `public` key, or the
   * caller's own slot on a `protected` key. A key that does not exist is a
   * no-op.
   */
  async deleteSlot(
    cruxId: string,
    key: string,
    visitorId?: string | null,
  ): Promise<void> {
    const writer = this.requireWriter(visitorId);
    const modes = await this.keyModes(cruxId, key);
    if (modes.length === 0) return;

    const slot = this.resolveMode(modes) === 'protected' ? writer : null;
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
