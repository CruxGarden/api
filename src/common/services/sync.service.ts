import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { LoggerService } from './logger.service';
import { KeyMaster } from './key.master';

/**
 * Represents a mapping between local and remote entity IDs
 */
interface SyncMapping {
  id: string;
  target_garden_url: string;
  entity_type: string;
  local_id: string;
  remote_id: string;
  created: Date;
  updated: Date;
}

/**
 * Represents a dimension relationship between Cruxes
 */
interface DimensionReference {
  id: string;
  source_id: string;
  target_id: string;
  type: 'gate' | 'garden' | 'growth' | 'graft';
  weight?: number;
}

/**
 * Represents a Crux entity with possible nested relationships
 */
interface CruxEntity {
  id: string;
  author_id: string;
  title: string;
  content?: string;
  type?: string;
  updated_at: Date;
  created_at: Date;
  dimensions?: DimensionReference[];
  gardens?: Array<{ crux_id: string }>;
  [key: string]: any;
}

/**
 * Parameters for syncing in a specific direction
 */
interface SyncDirectionParams {
  sourceUrl: string;
  targetUrl: string;
}

/**
 * Service for synchronizing Crux Garden data between different instances.
 * Implements bidirectional sync with ID mapping to handle collisions.
 */
@Injectable()
export class SyncService {
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
    private readonly keyMaster: KeyMaster,
  ) {
    this.logger = this.loggerService.createChildLogger('SyncService');
  }

  /**
   * Synchronizes data bidirectionally between local and target gardens.
   * Phase 1: Push local changes to target
   * Phase 2: Pull target changes to local
   */
  async syncGardens(
    localUrl: string,
    targetUrl: string,
  ): Promise<{ success: boolean; error?: Error }> {
    try {
      this.logger.info('Starting bidirectional sync', {
        localUrl,
        targetUrl,
      });

      // PHASE 1: Push local changes to target
      await this.syncDirection({
        sourceUrl: localUrl,
        targetUrl: targetUrl,
      });

      // PHASE 2: Pull target changes to local
      await this.syncDirection({
        sourceUrl: targetUrl,
        targetUrl: localUrl,
      });

      this.logger.info('Bidirectional sync completed successfully');
      return { success: true };
    } catch (error) {
      this.logger.error('Bidirectional sync failed', error as Error);
      return { success: false, error: error as Error };
    }
  }

  /**
   * Synchronizes data from source to target in one direction.
   * Handles ID mapping, conflict resolution (last-write-wins), and relationship remapping.
   */
  private async syncDirection(params: SyncDirectionParams): Promise<void> {
    const { sourceUrl, targetUrl } = params;

    this.logger.debug('Starting sync direction', { sourceUrl, targetUrl });

    // 1. Load existing mappings for this target
    const mappings = await this.dbService
      .query()
      .select<SyncMapping[]>('local_id', 'remote_id')
      .from('sync_mappings')
      .where('target_garden_url', targetUrl);

    const mappingLookup = new Map<string, string>(
      mappings.map((m) => [m.local_id, m.remote_id]),
    );

    this.logger.debug('Loaded sync mappings', {
      count: mappings.length,
      targetUrl,
    });

    // 2. Get entities modified since last sync
    const lastSync = await this.getLastSyncTime(targetUrl);
    const entities = await this.dbService
      .query()
      .select<CruxEntity[]>('*')
      .from('cruxes')
      .where('updated', '>', lastSync)
      .whereNull('deleted');

    this.logger.info('Found entities to sync', {
      count: entities.length,
      since: lastSync,
    });

    // 3. Process each entity
    for (const entity of entities) {
      await this.syncEntity(entity, targetUrl, sourceUrl, mappingLookup);
    }

    // 4. Sync paths (similar pattern as cruxes)
    await this.syncPaths(targetUrl, sourceUrl, mappingLookup);

    // 5. Update last sync time
    await this.setLastSyncTime(targetUrl, new Date());

    this.logger.debug('Sync direction completed', { sourceUrl, targetUrl });
  }

  /**
   * Syncs a single entity from local to target, handling ID mapping and conflicts
   */
  private async syncEntity(
    entity: CruxEntity,
    targetUrl: string,
    sourceUrl: string,
    mappingLookup: Map<string, string>,
  ): Promise<void> {
    let remoteId: string;

    // 3a. Determine remote ID
    if (mappingLookup.has(entity.id)) {
      // Already mapped - use existing remote ID
      remoteId = mappingLookup.get(entity.id)!;
      this.logger.debug('Using existing mapping', {
        localId: entity.id,
        remoteId,
      });
    } else {
      // First sync of this entity - check for ID collision
      const collision = await this.entityExists('cruxes', entity.id);

      if (collision) {
        // Generate new ID to avoid collision
        remoteId = this.keyMaster.generateId();

        this.logger.info('ID collision detected, generated new ID', {
          originalId: entity.id,
          newId: remoteId,
        });

        // Record bidirectional mappings
        await this.createBidirectionalMapping(
          entity.id,
          remoteId,
          targetUrl,
          sourceUrl,
          'crux',
        );

        mappingLookup.set(entity.id, remoteId);
      } else {
        // No collision - use same ID
        remoteId = entity.id;

        this.logger.debug('No collision, using same ID', { id: entity.id });

        // Still record mapping for consistency
        await this.createBidirectionalMapping(
          entity.id,
          remoteId,
          targetUrl,
          sourceUrl,
          'crux',
        );

        mappingLookup.set(entity.id, remoteId);
      }
    }

    // 3b. Remap all references to use target IDs
    const remapped = {
      ...entity,
      id: remoteId,
    };

    // Remap dimension references
    if (entity.dimensions) {
      remapped.dimensions = entity.dimensions.map((d) => ({
        ...d,
        source_id: mappingLookup.get(d.source_id) || d.source_id,
        target_id: mappingLookup.get(d.target_id) || d.target_id,
      }));
    }

    // Remap group garden references
    if (entity.type === 'group' && entity.gardens) {
      remapped.gardens = entity.gardens.map((g) => ({
        ...g,
        crux_id: mappingLookup.get(g.crux_id) || g.crux_id,
      }));
    }

    // 3c. Check for conflicts (last-write-wins)
    const existing = await this.findEntityById('cruxes', remoteId);

    if (!existing || entity.updated_at > existing.updated_at) {
      // No conflict or we're newer - write it
      await this.upsertEntity('cruxes', remapped);

      this.logger.debug('Entity synced successfully', {
        localId: entity.id,
        remoteId,
      });
    } else {
      // Existing is newer - skip
      this.logger.debug('Skipped entity: existing version is newer', {
        localId: entity.id,
        remoteId,
        localUpdated: entity.updated_at,
        remoteUpdated: existing.updated_at,
      });
    }
  }

  /**
   * Creates bidirectional sync mappings between source and target
   */
  private async createBidirectionalMapping(
    localId: string,
    remoteId: string,
    targetUrl: string,
    _sourceUrl: string, // Prefixed with _ to indicate intentionally unused
    entityType: string,
  ): Promise<void> {
    const now = new Date();

    // Forward mapping (local -> remote)
    await this.dbService
      .query()
      .insert({
        id: this.keyMaster.generateId(),
        target_garden_url: targetUrl,
        entity_type: entityType,
        local_id: localId,
        remote_id: remoteId,
        created: now,
        updated: now,
      })
      .into('sync_mappings');

    // Note: Reverse mapping (using _sourceUrl) would need to be created on the target system
    // This is a placeholder showing the conceptual bidirectional mapping
    this.logger.debug('Created sync mapping', {
      localId,
      remoteId,
      targetUrl,
      entityType,
    });
  }

  /**
   * Checks if an entity exists in the specified table
   */
  private async entityExists(
    tableName: string,
    entityId: string,
  ): Promise<boolean> {
    const result = await this.dbService
      .query()
      .select('id')
      .from(tableName)
      .where('id', entityId)
      .whereNull('deleted')
      .first();

    return !!result;
  }

  /**
   * Finds an entity by ID
   */
  private async findEntityById(
    tableName: string,
    entityId: string,
  ): Promise<CruxEntity | null> {
    const result = await this.dbService
      .query()
      .select('*')
      .from(tableName)
      .where('id', entityId)
      .whereNull('deleted')
      .first();

    return result || null;
  }

  /**
   * Inserts or updates an entity (upsert operation)
   */
  private async upsertEntity(
    tableName: string,
    entity: Partial<CruxEntity>,
  ): Promise<void> {
    const exists = await this.entityExists(tableName, entity.id!);

    if (exists) {
      // Update existing
      await this.dbService
        .query()
        .from(tableName)
        .where('id', entity.id)
        .update({
          ...entity,
          updated: new Date(),
        });
    } else {
      // Insert new
      await this.dbService
        .query()
        .insert({
          ...entity,
          created: entity.created_at || new Date(),
          updated: entity.updated_at || new Date(),
        })
        .into(tableName);
    }
  }

  /**
   * Syncs paths (ordered sequences of Cruxes)
   * TODO: Implement path syncing with similar pattern to crux syncing
   */
  private async syncPaths(
    targetUrl: string,
    sourceUrl: string,
    mappingLookup: Map<string, string>,
  ): Promise<void> {
    this.logger.debug('Path syncing not yet implemented', {
      targetUrl,
      sourceUrl,
      mappingCount: mappingLookup.size,
    });
    // TODO: Implement similar to syncDirection but for paths table
    // Will need to remap marker references to use correct crux IDs
  }

  /**
   * Gets the last sync timestamp for a target garden
   */
  private async getLastSyncTime(targetUrl: string): Promise<Date> {
    const result = await this.dbService
      .query()
      .select('last_sync')
      .from('sync_status')
      .where('target_garden_url', targetUrl)
      .first();

    // Default to Unix epoch if never synced
    return result?.last_sync || new Date(0);
  }

  /**
   * Updates the last sync timestamp for a target garden
   */
  private async setLastSyncTime(
    targetUrl: string,
    timestamp: Date,
  ): Promise<void> {
    const exists = await this.dbService
      .query()
      .select('id')
      .from('sync_status')
      .where('target_garden_url', targetUrl)
      .first();

    if (exists) {
      await this.dbService
        .query()
        .from('sync_status')
        .where('target_garden_url', targetUrl)
        .update({
          last_sync: timestamp,
          updated: new Date(),
        });
    } else {
      await this.dbService
        .query()
        .insert({
          id: this.keyMaster.generateId(),
          target_garden_url: targetUrl,
          last_sync: timestamp,
          created: new Date(),
          updated: new Date(),
        })
        .into('sync_status');
    }

    this.logger.debug('Updated last sync time', { targetUrl, timestamp });
  }
}
