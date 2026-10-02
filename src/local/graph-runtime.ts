import {
  TaskHistorySelection,
  taskHistorySelectionSchema,
} from './task-history';
import { GardenMoodService, SelectGardenMood } from './garden-mood.service';
import {
  isCredentialSetting,
  exportWithoutCredentials,
} from './installation-settings';
import { GardenMoodRepository } from './garden-mood.repository';
import { WorkspaceStateService } from './workspace-state.service';
import { EditRetentionService } from './edit-retention.service';
import { EditHistoryRepository } from './edit-history.repository';
import {
  EditHistoryService,
  EditCheckpointRestore,
  EditCheckpointCapture,
  captureEditCheckpoint,
  captureEditCheckpointRestore,
} from './edit-history.service';
import { GardenEntryRepository } from './garden-entry.repository';
import { GardenEntryService } from './garden-entry.service';
import type { PrepareImportedWorkspace } from './import-workspace';
import { GraphTransferService } from './graph-transfer.service';
import { GraphTransferRepository } from './graph-transfer.repository';
import {
  capturePrivateGraphImport,
  PrivateGraphImport,
} from './portable-graph';
import {
  GrowthContentService,
  GrowthSnapshotCreate,
  captureGrowthSnapshot,
  GrowthContentRestore,
  captureGrowthContentRestore,
} from './growth-content.service';
import { SelectedGraphRepository } from './selected-graph.repository';
import {
  SelectedGraphService,
  GraphSelection,
  captureGraphSelection,
} from './selected-graph.service';
import { FileContentRepository } from './file-content.repository';
import {
  FileContentService,
  FileContentCommit,
  captureFileContent,
  FileContentRead,
  FileContentSelection,
  captureFileContentSelection,
  captureFileContentRead,
  FileContentEdit,
  captureFileContentEdit,
} from './file-content.service';
import {
  captureWorkingCopyCreate,
  LocalWorkingCopyCreate,
  PrepareWorkingCopyFolder,
} from './working-copy-create';
import { TaskMergeRepository } from './task-merge.repository';
import { TaskMergeService } from './task-merge.service';
import {
  captureCruxCreate,
  LocalCruxCreate,
  PrepareCruxFolder,
} from './crux-create';
import { CruxLifecycleRepository } from './crux-lifecycle.repository';
import { CruxLifecycleService } from './crux-lifecycle.service';
import { WorkingCopyRepository } from './working-copy.repository';
import { WorkingCopyService } from './working-copy.service';
import 'reflect-metadata';
import { DynamicModule, INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isAbsolute, dirname, basename, join } from 'path';
import { realpath, stat, open as openFile } from 'fs/promises';
import {
  writeFileSync,
  renameSync,
  statSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { captureCruxUpdate, LocalCruxUpdate } from './crux-update';
import type { UpdateCruxDto } from '../crux/dto/update-crux.dto';
import type { DesktopContentStore } from './desktop-content';
import {
  inspectDesktopRecovery,
  inspectDesktopManifestRecovery,
} from './desktop-recovery';
import { inspectDesktopFile } from './desktop-schema';
import { checkpointDesktopMigration } from './startup-recovery';
import { migrateDesktopDatabase } from './desktop-migration';
import { bootstrapDesktopDatabase } from './desktop-bootstrap';
import { AsyncLocalStorage } from 'async_hooks';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { KeyMaster } from '../common/services/key.master';
import { sqliteGraphConfig } from '../common/database/sqlite-graph';
import { CruxGraphService } from '../crux/crux-graph.service';
import { CruxRepository } from '../crux/crux.repository';
import { DimensionService } from '../dimension/dimension.service';
import { DimensionRepository } from '../dimension/dimension.repository';
import { GardenMembershipRepository } from './garden-membership.repository';
import {
  GardenMembershipService,
  AddGardenMember,
  MoveGardenMember,
} from './garden-membership.service';

// A failed close leaves connection ownership uncertain: never admit another owner.
class DatabaseShutdownError extends AggregateError {}

@Module({})
class LocalGraphModule {
  static register(database: DbService, logger: LoggerService): DynamicModule {
    return {
      module: LocalGraphModule,
      providers: [
        { provide: DbService, useValue: database },
        { provide: LoggerService, useValue: logger },
        KeyMaster,
        CruxGraphService,
        CruxRepository,
        DimensionService,
        DimensionRepository,
        GardenMembershipRepository,
        GardenMembershipService,
        GardenMoodService,
        GardenMoodRepository,
        GardenEntryRepository,
        GardenEntryService,
        WorkingCopyRepository,
        WorkingCopyService,
        CruxLifecycleRepository,
        CruxLifecycleService,
        TaskMergeRepository,
        TaskMergeService,
        EditHistoryRepository,
        EditHistoryService,
        WorkspaceStateService,
        EditRetentionService,
        FileContentRepository,
        FileContentService,
        GrowthContentService,
        SelectedGraphRepository,
        SelectedGraphService,
        GraphTransferRepository,
        GraphTransferService,
      ],
    };
  }
}

import * as commands from './installation-commands';
import type {
  AuthorCreate,
  AuthorUpdate,
  Connection,
  DimensionCreate,
  StoreEntry,
} from './installation-commands';
export interface GraphOperations {
  crux: CruxGraphService;
  dimension: DimensionService;
  garden: GardenMembershipService;
  gardenMood: GardenMoodService;
  gardenEntry: GardenEntryService;
  workingCopy: WorkingCopyService;
  lifecycle: CruxLifecycleService;
  taskMerge: TaskMergeService;
  editHistory: EditHistoryService;
  workspaceState: WorkspaceStateService;
  fileContent: FileContentService;
  growthContent: GrowthContentService;
  selectedGraph: SelectedGraphService;
  graphTransfer: GraphTransferService;
}

/** Ephemeral invalidation for named commands, never a content payload or durable log.
 * Compatibility SQL and arbitrary execute callbacks do not produce notifications. */
export interface LocalGraphChange {
  readonly streamId: string;
  readonly sequence: number;
  readonly entity:
    | 'crux'
    | 'working-copy'
    | 'garden-membership'
    | 'database'
    | 'crux-lifecycle';
  readonly operation?: 'create' | 'purge' | 'trash' | 'restore';
  readonly id?: string;
  readonly cruxId?: string;
  readonly fields?: readonly string[];
  readonly metaKeys?: readonly string[];
}
type ChangeDetail = Omit<LocalGraphChange, 'streamId' | 'sequence'>;
type ChangeListener = (change: LocalGraphChange) => void | Promise<void>;

/**
 * One local API owner over one existing desktop database. No hosted AppModule,
 * HTTP listener, renderer backend switch or credentials are started here.
 *
 * Host-side entry only: execute callbacks and compatibility SQL must never be
 * exposed as arbitrary remote input. A transport maps authorized named tools
 * to these operations. Callbacks must await all work and not retain providers.
 */
export class LocalGraphRuntime {
  // Host-process admission, not an OS lock. Every app writer must still use
  // this runtime; an unrelated process/SQLite client is outside this guard.
  private static readonly ownedFiles = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private recoveryClosing: Promise<ArrayBuffer> | null = null;
  private readonly commandScope = new AsyncLocalStorage<boolean>();
  private readonly streamId = randomUUID();
  private sequence = 0;
  private readonly listeners = new Set<ChangeListener>();
  private replacing = false;
  private failure: Error | null = null;
  private db: DbService;
  private operations: GraphOperations;

  private constructor(
    private context: INestApplicationContext,
    private readonly ownershipKeys: string[],
    private readonly filename: string,
  ) {
    this.bind(context);
  }

  private bind(context: INestApplicationContext): void {
    this.context = context;
    this.db = context.get(DbService);
    this.operations = Object.freeze({
      crux: context.get(CruxGraphService),
      dimension: context.get(DimensionService),
      garden: context.get(GardenMembershipService),
      gardenMood: context.get(GardenMoodService),
      gardenEntry: context.get(GardenEntryService),
      workingCopy: context.get(WorkingCopyService),
      lifecycle: context.get(CruxLifecycleService),
      taskMerge: context.get(TaskMergeService),
      editHistory: context.get(EditHistoryService),
      workspaceState: context.get(WorkspaceStateService),
      fileContent: context.get(FileContentService),
      growthContent: context.get(GrowthContentService),
      selectedGraph: context.get(SelectedGraphService),
      graphTransfer: context.get(GraphTransferService),
    });
  }

  static open(
    filename: string,
    options?: { contentStore: DesktopContentStore },
  ): Promise<LocalGraphRuntime> {
    return this.start(filename, false, options?.contentStore);
  }

  /** Explicit fresh-file creation; never overwrites or bootstraps an existing file. */
  static create(filename: string): Promise<LocalGraphRuntime> {
    return this.start(filename, true);
  }

  private static async start(
    filename: string,
    create: boolean,
    contentStore?: DesktopContentStore,
  ): Promise<LocalGraphRuntime> {
    if (!isAbsolute(filename)) {
      throw new Error('Local API requires an absolute database file');
    }
    const canonical = create
      ? join(await realpath(dirname(filename)), basename(filename))
      : await realpath(filename);
    const ownershipKeys = [`path:${canonical}`];
    if (!create) {
      const file = await stat(canonical, { bigint: true });
      if (!file.isFile())
        throw new Error(
          'Local API requires an existing absolute database file',
        );
      ownershipKeys.push(`file:${file.dev}:${file.ino}`);
    }
    // Reserve canonical location before creating/opening. Existing files also
    // reserve inode identity, so symlink/hard-link aliases cannot gain an owner.
    if (ownershipKeys.some((key) => this.ownedFiles.has(key))) {
      throw new Error('Local API database is already owned in this process');
    }
    ownershipKeys.forEach((key) => this.ownedFiles.add(key));
    try {
      if (create) {
        const file = await openFile(canonical, 'wx', 0o600);
        try {
          const identity = await file.stat({ bigint: true });
          const key = `file:${identity.dev}:${identity.ino}`;
          ownershipKeys.push(key);
          this.ownedFiles.add(key);
        } finally {
          await file.close();
        }
      }
      if (!create) checkpointDesktopMigration(canonical, !!contentStore);
      const context = await this.openContext(canonical, create, contentStore);
      return new LocalGraphRuntime(context, ownershipKeys, canonical);
    } catch (error) {
      if (!(error instanceof DatabaseShutdownError))
        ownershipKeys.forEach((key) => this.ownedFiles.delete(key));
      throw error;
    }
  }

  private static async openContext(
    filename: string,
    create = false,
    contentStore?: DesktopContentStore,
  ): Promise<INestApplicationContext> {
    if (!create) inspectDesktopFile(filename, !!contentStore);
    const logger = new LoggerService();
    const database = new DbService(logger, sqliteGraphConfig(filename));
    let context: INestApplicationContext | undefined;
    try {
      context = await NestFactory.createApplicationContext(
        LocalGraphModule.register(database, logger),
        { logger: false, abortOnError: false },
      );
      if (create) await bootstrapDesktopDatabase(database.query());
      else await migrateDesktopDatabase(database.query(), contentStore);
      return context;
    } catch (error) {
      try {
        if (context) await context.close();
        else await database.onModuleDestroy();
      } catch (shutdown) {
        throw new DatabaseShutdownError(
          [error, shutdown],
          'Local API failed to close after startup failure',
        );
      }
      throw error;
    }
  }

  private admissionError(): Error | null {
    if (this.commandScope.getStore())
      return new Error('Nested local API commands are not allowed');
    if (this.failure) return this.failure;
    if (this.closing) return new Error('Local API is closing');
    if (this.replacing) return new Error('Local API is replacing its database');
    return null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    const result = this.pending.then(() =>
      this.commandScope.run(true, operation),
    );
    // One failed command must not poison later commands or shutdown.
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Serialize a complete command and commit all its repository writes together. */
  execute<T>(operation: (services: GraphOperations) => Promise<T>): Promise<T> {
    return this.enqueue(() =>
      this.db.transaction(() => operation(this.operations)),
    );
  }

  onChange(listener: ChangeListener): () => void {
    const refused = this.admissionError();
    if (refused) throw refused;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(detail: ChangeDetail): void {
    const change: LocalGraphChange = Object.freeze({
      ...detail,
      ...(detail.fields ? { fields: Object.freeze([...detail.fields]) } : {}),
      ...(detail.metaKeys
        ? { metaKeys: Object.freeze([...detail.metaKeys]) }
        : {}),
      streamId: this.streamId,
      sequence: ++this.sequence,
    });
    // Subscribers may enqueue reads after commit. Never await them inside the
    // owner queue, and never let a broken observer turn a committed save into failure.
    this.commandScope.exit(() => {
      for (const listener of [...this.listeners]) {
        try {
          Promise.resolve(listener(change)).catch(() => {});
        } catch {
          /* observer only */
        }
      }
    });
  }

  private executeChanged<T>(
    operation: (services: GraphOperations) => Promise<T>,
    change: (result: T) => ChangeDetail,
  ): Promise<T> {
    return this.enqueue(async () => {
      const result = await this.db.transaction(() =>
        operation(this.operations),
      );
      this.notify(change(result));
      return result;
    });
  }

  /** Host-only coherent source capture for the selected-transfer coordinator.
   * Private installation fields are retained; this is not a shareable envelope. */
  async captureSelectedGraph(
    selection: GraphSelection,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureGraphSelection(selection);
    if (typeof store?.read !== 'function')
      throw new Error('Use the host content store');
    const reader = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('Graph capture cannot write content');
      },
    };
    return this.execute(({ selectedGraph }) =>
      selectedGraph.capture(captured, reader),
    );
  }

  /** Host-only private backup. Never route this projection into public publishing. */
  async exportPrivateGraph(
    selection: GraphSelection,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureGraphSelection(selection);
    const reader = this.transferReader(store);
    return this.execute(({ graphTransfer }) =>
      graphTransfer.exportPrivate(captured, reader),
    );
  }

  async privateGraphReplacementToken(
    selection: GraphSelection,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureGraphSelection(selection);
    const reader = this.transferReader(store);
    return this.execute(({ graphTransfer }) =>
      graphTransfer.replacementToken(captured, reader),
    );
  }

  /** Identity/author binding must come from the authenticated destination host. */
  async importPrivateGraph(
    input: PrivateGraphImport,
    incoming: Pick<DesktopContentStore, 'read'>,
    destination: DesktopContentStore,
    prepare?: PrepareImportedWorkspace,
  ) {
    if (prepare !== undefined && typeof prepare !== 'function')
      throw new Error('Use the trusted workspace preparation host');
    const captured = capturePrivateGraphImport(input);
    const reader = this.transferReader(incoming);
    if (
      typeof destination?.write !== 'function' ||
      typeof destination?.read !== 'function'
    )
      throw new Error('Use the destination host content store');
    const writer = {
      read: destination.read.bind(destination),
      write: destination.write.bind(destination),
    };
    return this.executeChanged(
      ({ graphTransfer }) =>
        graphTransfer.importPrivate(captured, reader, writer, prepare),
      () => ({ entity: 'database' }),
    );
  }

  private transferReader(
    store: Pick<DesktopContentStore, 'read'>,
  ): DesktopContentStore {
    if (typeof store?.read !== 'function')
      throw new Error('Use a private archive content reader');
    return {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('Private archive reader cannot write');
      },
    };
  }

  /** Internal staged-content admission. No normal schema or renderer adoption yet. */
  async commitFileContent(
    input: FileContentCommit,
    store: DesktopContentStore,
  ) {
    const captured = captureFileContent(input);
    if (
      !store ||
      typeof store.read !== 'function' ||
      typeof store.write !== 'function'
    )
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.executeChanged(
      ({ fileContent }) => fileContent.commit(captured, capturedStore),
      () => ({ entity: 'crux', id: captured.cruxId, fields: ['fileContent'] }),
    );
  }

  /** Create/edit/rename/delete file batches through one API-owned transaction. */
  async editFileContent(input: FileContentEdit, store: DesktopContentStore) {
    const captured = captureFileContentEdit(input);
    if (
      !store ||
      typeof store.read !== 'function' ||
      typeof store.write !== 'function'
    )
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.executeChanged(
      ({ fileContent }) => fileContent.edit(captured, capturedStore),
      () => ({ entity: 'crux', id: captured.cruxId, fields: ['fileContent'] }),
    );
  }

  /** List the exact selected version's metadata without loading file payloads. */
  async listFileContent(
    input: FileContentSelection,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureFileContentSelection(input);
    if (!store || typeof store.read !== 'function')
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('File listing cannot write content');
      },
    };
    return this.execute(({ fileContent }) =>
      fileContent.list(captured, capturedStore),
    );
  }

  /** Host-only read of the exact selected version; never silently switches roots. */
  async lookupFileContent(
    input: FileContentRead,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureFileContentRead(input);
    if (!store || typeof store.read !== 'function')
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('File lookup cannot write content');
      },
    };
    return this.execute(({ fileContent }) =>
      fileContent.lookup(captured, capturedStore),
    );
  }

  /** Host-only read of the exact selected version; never silently switches roots. */
  async readFileContent(
    input: FileContentRead,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureFileContentRead(input);
    if (!store || typeof store.read !== 'function')
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('File reads cannot write content');
      },
    };
    return this.execute(({ fileContent }) =>
      fileContent.read(captured, capturedStore),
    );
  }

  /** Resume a durable restore intent with a trusted host materializer. A crash or
   * refused projection leaves the committed intent for startup to retry. */
  async finishContentProjection(
    id: string,
    store: Pick<DesktopContentStore, 'read'>,
    apply: (
      folder: string,
      entries: import('./file-manifest').FileEntry[],
    ) => void | Promise<void>,
  ) {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof apply !== 'function' ||
      typeof store?.read !== 'function'
    )
      throw new Error('Use a content owner and trusted projection host');
    const capturedStore = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('Projection cannot write stored content');
      },
    };
    return this.executeChanged(
      ({ fileContent }) =>
        fileContent.finishProjection(id, capturedStore, apply),
      () => ({ entity: 'crux', id, fields: ['fileContent'] }),
    );
  }

  /** Retain one immutable content root and connect the snapshot through Growth. */
  async createGrowthSnapshot(
    input: GrowthSnapshotCreate,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureGrowthSnapshot(input);
    if (!store || typeof store.read !== 'function')
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('Snapshots cannot rewrite content');
      },
    };
    return this.executeChanged(
      ({ growthContent }) => growthContent.create(captured, capturedStore),
      () => ({ entity: 'crux', id: captured.cruxId, fields: ['growth'] }),
    );
  }

  /** Preserve current content and restore a retained snapshot in one commit. */
  async restoreGrowthContent(
    input: GrowthContentRestore,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const captured = captureGrowthContentRestore(input);
    if (!store || typeof store.read !== 'function')
      throw new Error('Use the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('Restoration cannot rewrite content');
      },
    };
    return this.executeChanged(
      ({ growthContent }) => growthContent.restore(captured, capturedStore),
      () => ({
        entity: 'crux',
        id: captured.safety.cruxId,
        fields: ['editHistory', 'fileContent'],
      }),
    );
  }

  fileContentHead(id: string) {
    if (typeof id !== 'string' || !id)
      return Promise.reject(new Error('Use a Crux identity'));
    return this.execute(({ fileContent }) => fileContent.head(id));
  }

  /** Capture a complete detail patch, then read/merge/write in one transaction. */
  async updateCrux(id: string, patch: LocalCruxUpdate): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Use a Crux identity');
    const captured = captureCruxUpdate(patch);
    await this.executeChanged(
      async ({ crux, fileContent }) => {
        if (captured.meta !== undefined)
          await fileContent.assertWorkspaceWritable(id);
        const current = await crux.findById(id);
        // Enum strings were checked at admission. The desktop-only remoteId is
        // retained by the repository; it is never added to the hosted HTTP DTO.
        await crux.update(id, {
          ...captured,
          ...(captured.meta === undefined
            ? {}
            : { meta: { ...current.meta, ...captured.meta } }),
        } as UpdateCruxDto);
      },
      () => ({
        entity: 'crux',
        id,
        fields: Object.keys(captured),
        metaKeys: Object.keys(captured.meta ?? {}),
      }),
    );
  }

  /** Compatibility for hosts that adopted metadata commands first. */
  async mergeCruxMeta(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('Use a metadata object');
    return this.updateCrux(id, { meta: patch });
  }

  /** Merge Task descriptive state without giving metadata control of its identity or folder. */
  async updateWorkingCopyMeta(
    id: string,
    patch: Record<string, unknown>,
    title?: string,
  ): Promise<void> {
    if (
      typeof id !== 'string' ||
      !id ||
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch)
    )
      throw new Error('Use a Working Copy identity and metadata object');
    const captured = captureCruxUpdate({ meta: patch, title });
    await this.executeChanged(
      async ({ workingCopy, fileContent }) => {
        await fileContent.assertWorkspaceWritable(id);
        return workingCopy.updateMeta(id, captured.meta!, captured.title);
      },
      (cruxId) => ({
        entity: 'working-copy',
        id,
        cruxId,
        fields: Object.keys(captured),
        metaKeys: Object.keys(captured.meta!),
      }),
    );
  }

  async prepareWorkingCopyFolder(
    id: string,
    revision: number,
    prepare: PrepareWorkingCopyFolder,
  ): Promise<string> {
    this.validateSetupRevision(id, revision);
    if (typeof prepare !== 'function')
      throw new Error('Use the native Task folder preparer');
    const result = await this.executeChanged(
      ({ workingCopy }) => workingCopy.prepareFolder(id, revision, prepare),
      (saved) => ({
        entity: 'working-copy',
        id,
        cruxId: saved.cruxId,
        fields: ['phase', 'projectFolder'],
      }),
    );
    return result.folder;
  }
  async finishWorkingCopySetup(
    id: string,
    revision: number,
    phase: 'ready' | 'failed',
  ): Promise<void> {
    this.validateSetupRevision(id, revision);
    if (phase !== 'ready' && phase !== 'failed')
      throw new Error('Use a supported Task setup result');
    await this.executeChanged(
      ({ workingCopy }) => workingCopy.finishSetup(id, revision, phase),
      (cruxId) => ({ entity: 'working-copy', id, cruxId, fields: ['phase'] }),
    );
  }
  private validateSetupRevision(id: string, revision: number) {
    if (
      typeof id !== 'string' ||
      !id ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Use a Task identity and valid setup revision');
  }

  async createWorkingCopy(
    input: LocalWorkingCopyCreate,
    store?: DesktopContentStore,
  ): Promise<void> {
    const captured = captureWorkingCopyCreate(input);
    if (!store)
      throw new Error(
        'Use the host content store to retain Task starting state',
      );
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    await this.executeChanged(
      ({ workingCopy }) => workingCopy.create(captured, capturedStore),
      () => ({
        entity: 'working-copy',
        id: captured.id,
        cruxId: captured.cruxId,
        fields: ['phase'],
      }),
    );
  }

  async workingCopyBase(id: string, store: DesktopContentStore) {
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.execute(({ workingCopy }) =>
      workingCopy.readBase(id, capturedStore),
    );
  }

  async inspectTaskHistory(
    input: TaskHistorySelection,
    store: DesktopContentStore,
  ) {
    const captured = taskHistorySelectionSchema.parse(
      input,
    ) as TaskHistorySelection;
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.execute(({ taskMerge }) =>
      taskMerge.inspectHistory(captured, capturedStore),
    );
  }

  async readTaskHistoryFile(
    input: TaskHistorySelection,
    root: string,
    path: string,
    store: DesktopContentStore,
  ) {
    const captured = taskHistorySelectionSchema.parse(
      input,
    ) as TaskHistorySelection;
    if (
      typeof root !== 'string' ||
      !/^[a-f0-9]{64}$/.test(root) ||
      typeof path !== 'string'
    )
      throw new Error('Use a selected Task history root and file path');
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.execute(({ taskMerge }) =>
      taskMerge.readHistoryFile(captured, root, path, capturedStore),
    );
  }

  async saveTaskReview(
    reviewData: string,
    expectedData?: string,
    store?: DesktopContentStore,
  ): Promise<void> {
    if (
      typeof reviewData !== 'string' ||
      (expectedData !== undefined && typeof expectedData !== 'string')
    )
      throw new Error('Use serialized review data');
    const next = JSON.parse(reviewData);
    const expected =
      expectedData === undefined ? undefined : JSON.parse(expectedData);
    if (!store)
      throw new Error('Use the host content store to retain a review');
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.save(next, expected, capturedStore),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async beginTaskMerge(
    id: string,
    reviewData: string,
    store?: DesktopContentStore,
  ): Promise<void> {
    if (typeof id !== 'string' || !id || typeof reviewData !== 'string')
      throw new Error('Use a review identity and its checked journal');
    // Strings capture the exact reviewed input before waiting for API ownership.
    const captured = JSON.parse(reviewData);
    const capturedStore = store
      ? { read: store.read.bind(store), write: store.write.bind(store) }
      : undefined;
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.begin(id, captured, capturedStore),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async releaseTaskReview(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Use a review identity');
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.release(id),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async completeTaskMerge(
    id: string,
    store: DesktopContentStore,
  ): Promise<void> {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof store?.read !== 'function' ||
      typeof store?.write !== 'function'
    )
      throw new Error('Use a merge identity and the host content store');
    const capturedStore = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.complete(id, capturedStore),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async setWorkingCopyArchived(
    id: string,
    archived: boolean,
    revision: number,
  ): Promise<void> {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof archived !== 'boolean' ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Use a Task identity, archive state and valid revision');
    await this.executeChanged(
      ({ workingCopy }) => workingCopy.setArchived(id, archived, revision),
      (cruxId) => ({ entity: 'working-copy', id, cruxId, fields: ['phase'] }),
    );
  }

  async createCrux(
    input: LocalCruxCreate,
    prepareFolder?: PrepareCruxFolder,
    store?: DesktopContentStore,
  ): Promise<string> {
    const { initialFiles, ...metadata } = input;
    const captured = captureCruxCreate(metadata);
    const content =
      initialFiles === undefined
        ? null
        : captureFileContentEdit({
            cruxId: captured.id ?? 'new-crux',
            expected: null,
            changes: initialFiles,
          });
    if (content && !store)
      throw new Error('Initial files require the API content store');
    const capturedStore = store
      ? { read: store.read.bind(store), write: store.write.bind(store) }
      : null;
    return this.executeChanged(
      async ({ lifecycle, garden, fileContent }) => {
        const { gardenId, ...details } = captured;
        const id = await lifecycle.create(details, prepareFolder);
        if (content)
          await fileContent.initialize(
            { ...content, cruxId: id },
            capturedStore!,
          );
        if (gardenId)
          await garden.add({
            gardenId,
            memberId: id,
            authorId: details.authorId,
            homeId: details.homeId,
          });
        return id;
      },
      (id) => ({ entity: 'crux-lifecycle', operation: 'create', id }),
    );
  }

  async setCruxTrashed(id: string, trashed: boolean): Promise<void> {
    if (typeof id !== 'string' || !id || typeof trashed !== 'boolean')
      throw new Error('Use a Crux identity and trash state');
    await this.executeChanged(
      ({ lifecycle }) => lifecycle.setTrashed(id, trashed),
      () => ({
        entity: 'crux-lifecycle',
        operation: trashed ? 'trash' : 'restore',
        id,
      }),
    );
  }

  async deleteCrux(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Use a Crux identity');
    await this.executeChanged(
      ({ lifecycle }) => lifecycle.purge(id),
      () => ({ entity: 'crux-lifecycle', operation: 'purge', id }),
    );
  }

  /** Explicit local installation entry, never inferred from unlinked nodes. */
  enterLocalGarden() {
    return this.enqueue(async () => {
      const result = await this.db.transaction(() =>
        this.operations.gardenEntry.enter(),
      );
      if (result.created)
        this.notify({
          entity: 'crux-lifecycle',
          operation: 'create',
          id: result.entry.id,
        });
      return result.entry;
    });
  }

  readGardenMood(gardenId: string) {
    return this.execute(({ gardenMood }) => gardenMood.read(gardenId));
  }
  resolveGardenMood(gardenId: string) {
    return this.execute(({ gardenMood }) => gardenMood.resolve(gardenId));
  }
  selectGardenMood(input: SelectGardenMood) {
    const captured = structuredClone(input);
    return this.executeChanged(
      ({ gardenMood }) => gardenMood.select(captured),
      () => ({
        entity: 'crux',
        id: captured.gardenId,
        metaKeys: ['moodSelection'],
      }),
    );
  }

  addGardenMember(input: AddGardenMember) {
    const captured = { ...input };
    return this.executeChanged(
      ({ garden }) => garden.add(captured),
      () => ({
        entity: 'garden-membership',
        id: captured.gardenId,
        cruxId: captured.memberId,
      }),
    );
  }

  removeGardenMember(gardenId: string, memberId: string) {
    return this.executeChanged(
      ({ garden }) => garden.remove(gardenId, memberId),
      () => ({ entity: 'garden-membership', id: gardenId, cruxId: memberId }),
    );
  }

  listGardenMembers(
    gardenId: string,
    options?: { limit?: number; after?: string },
  ) {
    const captured = { ...options };
    return this.execute(({ garden }) => garden.list(gardenId, captured));
  }

  listEditHistory(cruxId: string) {
    return this.execute(({ editHistory }) => editHistory.list(cruxId));
  }
  inspectEditCheckpoint(
    cruxId: string,
    checkpointId: string,
    store: Pick<DesktopContentStore, 'read'>,
  ) {
    const content = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('History inspection is read-only');
      },
    };
    return this.execute(({ editHistory }) =>
      editHistory.inspect(cruxId, checkpointId, content),
    );
  }
  createEditCheckpoint(
    input: EditCheckpointCapture,
    store: DesktopContentStore,
  ) {
    const captured = captureEditCheckpoint(input);
    const content = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.executeChanged(
      ({ editHistory }) =>
        editHistory.capture(captured, content, captured.reason),
      () => ({
        entity: 'crux',
        fields: ['editHistory'],
        id: captured.cruxId,
        cruxId: captured.cruxId,
      }),
    );
  }
  restoreEditCheckpoint(
    input: EditCheckpointRestore,
    store: DesktopContentStore,
  ) {
    const captured = captureEditCheckpointRestore(input);
    const content = {
      read: store.read.bind(store),
      write: store.write.bind(store),
    };
    return this.executeChanged(
      ({ editHistory }) => editHistory.restore(captured, content),
      () => ({
        entity: 'crux',
        fields: ['editHistory', 'fileContent'],
        id: captured.cruxId,
        cruxId: captured.cruxId,
      }),
    );
  }

  gardenParents(memberId: string) {
    return this.execute(({ garden }) => garden.parents(memberId));
  }

  moveGardenMember(input: MoveGardenMember) {
    const captured = {
      ...input,
      expectedParents: Array.isArray(input.expectedParents)
        ? [...input.expectedParents]
        : input.expectedParents,
    };
    return this.executeChanged(
      ({ garden }) => garden.move(captured),
      () => ({
        entity: 'garden-membership',
        id: captured.gardenId,
        cruxId: captured.memberId,
      }),
    );
  }

  private async withConnection<T>(
    operation: (connection: any) => T,
  ): Promise<T> {
    const client = this.db.query().client;
    const connection = await client.acquireConnection();
    try {
      return operation(connection);
    } finally {
      await client.releaseConnection(connection);
    }
  }

  /** Temporary internal bridge for legacy callers; preserve native row shapes. */
  private async legacy<T>(
    sql: string,
    params: unknown[],
    method: 'run' | 'get' | 'all',
  ): Promise<T> {
    const statement = sql.replace(
      /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
      '',
    );
    if (
      /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH)\b/i.test(
        statement,
      )
    ) {
      return Promise.reject(
        new Error(
          'Use an owned API transaction; legacy SQL cannot change connection ownership',
        ),
      );
    }
    // Some PRAGMAs change connection state during preparation and SQLite still
    // calls them read-only. Read ports admit queries, plus this inspection used
    // by recovery checks; other introspection uses SELECT pragma_* table functions.
    if (
      method !== 'run' &&
      !/^(?:SELECT|WITH)\b/i.test(statement) &&
      !/^PRAGMA\s+database_list\s*;?\s*$/i.test(statement)
    ) {
      throw new Error(
        'SQL reads must be read-only; use a named API command for changes',
      );
    }
    // Capture at admission: callers may reuse arrays or change nested state
    // while a previous command is still running. Keep native row conventions.
    const bindings = params.map((value) => {
      if (value === undefined) return null;
      if (typeof value === 'boolean') return Number(value);
      if (Buffer.isBuffer(value)) return Buffer.from(value);
      if (value !== null && typeof value === 'object') {
        return JSON.stringify(value);
      }
      return value;
    });
    return this.enqueue(() =>
      this.withConnection((connection) => {
        const prepared = connection.prepare(sql);
        // WITH may introduce a write with RETURNING. SQLite, not a keyword
        // search, decides whether executing the prepared query can write.
        if (method !== 'run' && !prepared.readonly) {
          throw new Error(
            'SQL reads must be read-only; use a named API command for changes',
          );
        }
        const result = prepared[method](...bindings);
        return (method === 'run' ? { changes: result.changes } : result) as T;
      }),
    );
  }

  /** The installation's settings (secrets never enter this table). */
  listSettings(): Promise<{ key: string; value: string }[]> {
    return this.enqueue(() =>
      this.withConnection((connection) =>
        (
          connection
            .prepare('SELECT key, value FROM settings ORDER BY key')
            .all() as { key: string; value: string }[]
        ).filter((row) => !isCredentialSetting(row.key)),
      ),
    );
  }

  /** Write one setting; the value is captured at admission. */
  putSetting(key: string, value: string): Promise<void> {
    if (typeof key !== 'string' || !key || typeof value !== 'string')
      return Promise.reject(new Error('Use a setting key and a text value'));
    if (isCredentialSetting(key))
      return Promise.reject(
        new Error('Credentials cannot be saved as installation settings'),
      );
    const captured = { key, value };
    return this.enqueue(() =>
      this.withConnection((connection) => {
        connection
          .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .run(captured.key, captured.value);
      }),
    );
  }

  /** Remove one setting; removing an absent one is not an error. */
  removeSetting(key: string): Promise<void> {
    if (typeof key !== 'string' || !key)
      return Promise.reject(new Error('Use a setting key'));
    return this.enqueue(() =>
      this.withConnection((connection) => {
        connection.prepare('DELETE FROM settings WHERE key = ?').run(key);
      }),
    );
  }

  /** One named installation command on the owner's connection, in admission order. */
  private installation<T>(
    operation: (connection: Connection) => T,
  ): Promise<T> {
    return this.enqueue(() => this.withConnection(operation));
  }

  createAuthor(input: AuthorCreate) {
    const captured = structuredClone(input);
    return this.installation((c) => commands.createAuthor(c, captured));
  }

  updateAuthor(id: string, patch: AuthorUpdate) {
    const captured = structuredClone(patch);
    return this.installation((c) => commands.updateAuthor(c, id, captured));
  }

  rekeyLocalAuthor(input: { oldId: string; newId: string; accountId: string }) {
    const captured = { ...input };
    return this.installation((c) => commands.rekeyLocalAuthor(c, captured));
  }

  createDimension(input: DimensionCreate) {
    const captured = structuredClone(input);
    return this.installation((c) => commands.createDimension(c, captured));
  }

  updateDimension(
    id: string,
    patch: Parameters<typeof commands.updateDimension>[2],
  ) {
    const captured = structuredClone(patch);
    return this.installation((c) => commands.updateDimension(c, id, captured));
  }

  deleteDimension(id: string) {
    return this.installation((c) => commands.deleteDimension(c, id));
  }

  storeSet(entry: StoreEntry) {
    const captured = { ...entry };
    return this.installation((c) => commands.storeSet(c, captured));
  }

  storeDelete(input: {
    cruxId: string;
    key: string;
    visitorId?: string | null;
  }) {
    const captured = { ...input };
    return this.installation((c) => commands.storeDelete(c, captured));
  }

  storeClear(cruxId: string) {
    return this.installation((c) => commands.storeClear(c, cruxId));
  }

  /** Empty the Garden's records; the host removes content bytes and caches. */
  wipeGarden() {
    return this.installation((c) => commands.wipeGarden(c));
  }

  /** Drop another machine's handles after a whole-Garden image was admitted. */
  sanitizeImportedGarden() {
    return this.installation((c) => commands.sanitizeImportedGarden(c));
  }

  setWorkingCopyFolder(id: string, folder: string) {
    return this.installation((c) =>
      commands.setWorkingCopyFolder(c, id, folder),
    );
  }

  run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.legacy(sql, params, 'run');
  }

  get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return this.legacy(sql, params, 'get');
  }

  all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.legacy(sql, params, 'all');
  }

  /** Whole-installation database image; never a selected Garden share format. */
  exportDatabase(): Promise<ArrayBuffer> {
    return this.enqueue(() =>
      this.withConnection((connection) => {
        return exportWithoutCredentials(connection.serialize());
      }),
    );
  }

  /**
   * Host-internal whole-installation replacement. The host must stage/verify
   * content and quiesce its writers first. Returns the previous image, captured
   * after every admitted command, for rollback of subsequent host-level work.
   * Ownership stays reserved through preparation, close, rename and reopen.
   */
  replaceDatabase(data: ArrayBuffer): Promise<ArrayBuffer> {
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    let captured: ArrayBuffer;
    try {
      captured = inspectDesktopRecovery(data).database;
    } catch (error) {
      return Promise.reject(error);
    }
    const replacement = this.enqueue(() =>
      this.replaceCapturedDatabase(captured),
    );
    this.replacing = true;
    return replacement.then(
      (previous) => {
        this.replacing = false;
        this.notify({ entity: 'database' });
        return previous;
      },
      (error) => {
        this.replacing = false;
        throw error;
      },
    );
  }

  /** Current-format whole-installation restore, with verified incoming and rollback
   * content. The host must retain blobs and quiesce its filesystem writers. */
  replaceDatabaseWithContent(
    data: ArrayBuffer,
    store: Pick<DesktopContentStore, 'read'>,
  ): Promise<ArrayBuffer> {
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    let captured: ArrayBuffer;
    let reader: Pick<DesktopContentStore, 'read'>;
    try {
      if (!(data instanceof ArrayBuffer))
        throw new Error('Use a database image');
      if (!store || typeof store.read !== 'function')
        throw new Error('Use the host content store');
      captured = Uint8Array.from(new Uint8Array(data)).buffer;
      reader = { read: store.read.bind(store) };
    } catch (error) {
      return Promise.reject(error);
    }
    const inspect = async (image: ArrayBuffer) => {
      const result = await inspectDesktopManifestRecovery(image, reader);
      if (result.schemaVersion < 5)
        throw new Error('Use a current-format database image');
      return result.database;
    };
    const replacement = this.enqueue(async () =>
      this.replaceCapturedDatabase(
        await inspect(captured),
        inspect,
        reader
          ? {
              read: reader.read,
              write: async () => {
                throw new Error('Recovery cannot rewrite immutable content');
              },
            }
          : undefined,
        true,
      ),
    );
    this.replacing = true;
    return replacement.then(
      (previous) => {
        this.replacing = false;
        this.notify({ entity: 'database' });
        return previous;
      },
      (error) => {
        this.replacing = false;
        throw error;
      },
    );
  }

  private reserveCurrentIdentity(): void {
    // No await between rename and reserving the new inode: hard-link aliases
    // cannot acquire ownership while a replacement context is opening.
    const file = statSync(this.filename, { bigint: true });
    const key = `file:${file.dev}:${file.ino}`;
    if (!this.ownershipKeys.includes(key)) {
      this.ownershipKeys.push(key);
      LocalGraphRuntime.ownedFiles.add(key);
    }
  }

  private async replaceCapturedDatabase(
    data: ArrayBuffer,
    inspectRecovery: (image: ArrayBuffer) => Promise<ArrayBuffer> = async (
      image,
    ) => inspectDesktopRecovery(image).database,
    contentStore?: DesktopContentStore,
    rehomeFolders = false,
  ): Promise<ArrayBuffer> {
    const prefix = join(
      dirname(this.filename),
      `.${basename(this.filename)}.${randomUUID()}`,
    );
    const candidatePath = `${prefix}.restore`;
    const recoveryPath = `${prefix}.recovery`;
    let candidate: INestApplicationContext | undefined;
    let candidateClosed = false;
    let closingStarted = false;
    let closed = false;
    let swapped = false;
    let retainFiles = false;
    try {
      writeFileSync(candidatePath, Buffer.from(data), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      // Prepare the complete incoming file through the same API adapter before
      // touching the working connection. Unknown tables/columns remain intact.
      candidate = await LocalGraphRuntime.openContext(
        candidatePath,
        false,
        contentStore,
      );
      if (rehomeFolders) {
        // Incoming paths describe another installation, never filesystem authority
        // here. Clear them before the atomic swap, including a crash before the
        // renderer recreates folders. The rollback image keeps its local paths.
        const query = candidate.get(DbService).query();
        await query.transaction(async (transaction) => {
          await transaction('cruxes')
            .whereRaw('json_valid(meta)')
            .update({
              meta: transaction.raw("json_remove(meta, '$.projectFolder')"),
            });
          await transaction('working_copies').update({ project_folder: null });
        });
      }
      await candidate.close();
      candidateClosed = true;
      const staged = openSync(candidatePath, 'r+');
      try {
        fsyncSync(staged);
      } finally {
        closeSync(staged);
      }
      const previous = await this.withConnection(
        (connection) => Uint8Array.from(connection.serialize()).buffer,
      );
      const recovery = await inspectRecovery(previous);
      writeFileSync(recoveryPath, Buffer.from(recovery), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      closingStarted = true;
      await this.context.close();
      closed = true;
      renameSync(candidatePath, this.filename);
      swapped = true;
      this.reserveCurrentIdentity();
      this.bind(await LocalGraphRuntime.openContext(this.filename));
      return previous;
    } catch (error) {
      // Never reopen across a connection whose shutdown is uncertain.
      if (
        (closingStarted && !closed) ||
        error instanceof DatabaseShutdownError
      ) {
        retainFiles = true;
        this.failure = new AggregateError(
          [error],
          `Local API recovery required; retained files at ${prefix}`,
        );
        throw this.failure;
      }
      if (closed) {
        try {
          if (swapped) {
            renameSync(recoveryPath, this.filename);
            this.reserveCurrentIdentity();
          }
          this.bind(await LocalGraphRuntime.openContext(this.filename));
        } catch (rollback) {
          retainFiles = true;
          this.failure = new AggregateError(
            [error, rollback],
            `Local API recovery required; retained files at ${prefix}`,
          );
          throw this.failure;
        }
      }
      throw error;
    } finally {
      if (candidate && !candidateClosed) retainFiles = true;
      if (!retainFiles) {
        for (const file of [candidatePath, recoveryPath]) {
          try {
            rmSync(file, { force: true });
          } catch {
            /* orphan cleanup is separate */
          }
        }
      }
    }
  }

  /**
   * Close this owner with a final recovery image containing every admitted write.
   * New commands are refused immediately. Even if serialization fails, shutdown
   * drains and closes before rejecting; the existing file can be reopened.
   * Host-internal full-installation recovery, never a selected Garden export.
   */
  closeWithRecoveryImage(): Promise<ArrayBuffer> {
    if (this.commandScope.getStore())
      return Promise.reject(
        new Error('Cannot close the local API within a command'),
      );
    if (this.recoveryClosing) return this.recoveryClosing;
    if (this.closing) return Promise.reject(new Error('Local API is closing'));
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    const image = this.exportDatabase();
    const closed = this.close();
    this.recoveryClosing = Promise.allSettled([image, closed]).then(
      ([snapshot, shutdown]) => {
        if (snapshot.status === 'rejected' && shutdown.status === 'rejected')
          throw new AggregateError(
            [snapshot.reason, shutdown.reason],
            'Recovery export and local API shutdown failed',
          );
        if (snapshot.status === 'rejected') throw snapshot.reason;
        if (shutdown.status === 'rejected') throw shutdown.reason;
        return snapshot.value;
      },
    );
    return this.recoveryClosing;
  }

  /** Stop admission immediately, drain admitted operations, then close SQLite. */
  close(): Promise<void> {
    if (this.commandScope.getStore()) {
      return Promise.reject(
        new Error('Cannot close the local API within a command'),
      );
    }
    this.closing ??= this.pending.then(async () => {
      if (this.failure) throw this.failure;
      await this.context.close();
      this.listeners.clear();
      // Release only after SQLite is closed; failed shutdown must not admit
      // another owner over a potentially live connection.
      this.ownershipKeys.forEach((key) =>
        LocalGraphRuntime.ownedFiles.delete(key),
      );
    });
    return this.closing;
  }
}
