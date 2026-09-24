import { isDeepStrictEqual } from 'util';
import { CruxGraphService } from '../crux/crux-graph.service';
import { DimensionType } from '../common/types/enums';
import { captureMetadata } from './json-metadata';
import { editWorkspaceSchema, EditWorkspaceContext } from './edit-history';
import { EditRetentionService } from './edit-retention.service';
import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  FileContentService,
  FileContentSelection,
  captureFileContentSelection,
} from './file-content.service';
import { FileContentRepository } from './file-content.repository';
import { EditHistoryRepository } from './edit-history.repository';
import { EditCheckpoint } from './edit-history';
import { DesktopContentStore } from './desktop-content';
import { FileManifest } from './file-manifest';
import { RepositoryResponse } from '../common/types/interfaces';

export interface EditCheckpointCapture extends FileContentSelection {
  reason?: EditCheckpoint['reason'];
}
export function captureEditCheckpoint(
  input: EditCheckpointCapture,
): EditCheckpointCapture {
  const selected = captureFileContentSelection(input);
  if (
    input.reason !== undefined &&
    input.reason !== 'autosave' &&
    input.reason !== 'safety'
  )
    throw new Error('Choose automatic recovery or a protected safety copy');
  return { ...selected, reason: input.reason ?? 'autosave' };
}

export interface EditCheckpointRestore extends FileContentSelection {
  checkpointId: string;
  workspace?: { expectedMeta: Record<string, unknown> };
}
export function captureEditCheckpointRestore(
  input: EditCheckpointRestore,
): EditCheckpointRestore {
  const selected = captureFileContentSelection(input);
  if (!isUUID(input.checkpointId))
    throw new Error('Select a retained edit checkpoint');
  return {
    ...selected,
    checkpointId: input.checkpointId,
    ...(input.workspace
      ? {
          workspace: {
            expectedMeta: captureMetadata(input.workspace.expectedMeta),
          },
        }
      : {}),
  };
}
const unwrap = <T>(result: RepositoryResponse<T>): T => {
  if (result.error)
    throw new InternalServerErrorException(result.error.message);
  return result.data!;
};

/** Internal content recovery, deliberately outside the Crux/Dimension graph. */
@Injectable()
export class EditHistoryService {
  constructor(
    private readonly history: EditHistoryRepository,
    private readonly content: FileContentService,
    private readonly files: FileContentRepository,
    private readonly retention: EditRetentionService,
    private readonly crux: CruxGraphService,
  ) {}
  async list(cruxId: string) {
    if (!isUUID(cruxId)) throw new Error('Use a content owner identity');
    await this.content.owner(cruxId);
    return (
      unwrap(await this.history.read(cruxId)) ?? {
        cruxId,
        revision: 0,
        checkpoints: [],
      }
    );
  }
  async capture(
    input: FileContentSelection,
    store: DesktopContentStore,
    reason: EditCheckpoint['reason'] = 'autosave',
  ) {
    const head = await this.content.admit(input);
    if (!head)
      throw new ConflictException('Edit history requires committed content');
    await new FileManifest(store).verify(head.root);
    return this.retention.record(input.cruxId, head.root, reason);
  }

  /** A version restore can replace conversation context. Retain it without a version node. */
  async captureWorkspace(
    input: FileContentSelection,
    store: DesktopContentStore,
  ) {
    const head = await this.content.admit(input);
    if (!head)
      throw new ConflictException(
        'Workspace recovery requires committed content',
      );
    const owner = await this.content.owner(input.cruxId);
    const edges = await this.crux.getDimensionsQuery(
      input.cruxId,
      DimensionType.GROWTH,
      false,
      false,
    );
    const latest = [...edges].sort(
      (a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0),
    )[0];
    const workspace = editWorkspaceSchema.parse(
      captureMetadata({
        parentId: Object.prototype.hasOwnProperty.call(
          owner.meta?.settings ?? {},
          'activeBranch',
        )
          ? owner.meta.settings.activeBranch
          : (latest?.target_id ?? null),
        messages: owner.meta?.messages ?? [],
        entryFile: owner.meta?.settings?.entryFile ?? null,
      }),
    ) as EditWorkspaceContext;
    await this.assertWorkspace(input.cruxId, workspace);
    await new FileManifest(store).verify(head.root);
    return this.retention.record(
      input.cruxId,
      head.root,
      'safety',
      false,
      workspace,
    );
  }
  private async assertWorkspace(
    cruxId: string,
    workspace: EditWorkspaceContext,
  ) {
    if (!workspace.parentId) return;
    const parentOwner = await this.files.parentOwner(
      cruxId,
      workspace.parentId,
    );
    const parent = await this.crux.findById(workspace.parentId);
    const source = await this.content.owner(cruxId);
    const head = await this.content.head(parent.id);
    const edges = await this.crux.getDimensionsQuery(
      parentOwner,
      DimensionType.GROWTH,
      false,
      false,
    );
    if (
      !head ||
      head.revision !== 1 ||
      head.formatVersion !== 1 ||
      parent.kind !== 'snapshot' ||
      parent.deleted ||
      parent.meta?.contentOwnerId !== parentOwner ||
      parent.authorId !== source.authorId ||
      parent.homeId !== source.homeId ||
      !edges.some((edge) => edge.target_id === parent.id)
    )
      throw new ConflictException(
        'Recovery context requires retained Growth of this workspace',
      );
  }

  async inspect(
    cruxId: string,
    checkpointId: string,
    store: DesktopContentStore,
  ) {
    const retained = await this.list(cruxId);
    const checkpoint = retained.checkpoints.find(
      (item) => item.id === checkpointId,
    );
    if (!checkpoint)
      throw new ConflictException('This edit checkpoint is no longer retained');
    return {
      checkpoint,
      files: await new FileManifest(store).entries(checkpoint.root),
    };
  }
  async restore(input: EditCheckpointRestore, store: DesktopContentStore) {
    await this.content.admit(input);
    const retained = await this.list(input.cruxId);
    const checkpoint = retained.checkpoints.find(
      (item) => item.id === input.checkpointId,
    );
    if (!checkpoint)
      throw new ConflictException('This edit checkpoint is no longer retained');
    await new FileManifest(store).verify(checkpoint.root);
    if (input.workspace && !checkpoint.workspace)
      throw new ConflictException('This recovery copy contains files only');
    if (input.workspace)
      await this.assertWorkspace(input.cruxId, checkpoint.workspace!);
    const safety = input.workspace
      ? await this.captureWorkspace(input, store)
      : await this.capture(input, store, 'safety');
    const head = await this.content.commit(
      { cruxId: input.cruxId, expected: input.expected, root: checkpoint.root },
      store,
    );
    if (input.workspace) {
      const context = checkpoint.workspace!;
      await this.files.restoreWorkspace(
        input.cruxId,
        input.workspace.expectedMeta,
        context.messages,
        context.parentId,
        context.entryFile,
        head,
      );
    } else await this.files.queueProjection(input.cruxId, head);
    const saved = await this.list(input.cruxId);
    if (
      !isDeepStrictEqual(
        saved.checkpoints.find((item) => item.id === safety.id),
        safety,
      ) ||
      (checkpoint.workspace &&
        !isDeepStrictEqual(
          saved.checkpoints.find((item) => item.id === checkpoint.id),
          checkpoint,
        ))
    )
      throw new InternalServerErrorException(
        'Recovery retention did not persist',
      );
    return { head, safety };
  }
}
