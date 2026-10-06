import { isDeepStrictEqual } from 'util';
import { Injectable, ConflictException } from '@nestjs/common';
import { CruxGraphService } from '../crux/crux-graph.service';
import { DimensionType } from '../common/types/enums';
import { captureMetadata } from './json-metadata';
import { editWorkspaceSchema, EditWorkspaceContext } from './edit-history';
import {
  FileContentService,
  FileContentSelection,
  captureFileContentSelection,
} from './file-content.service';
import { FileContentRepository } from './file-content.repository';
import { DesktopContentStore } from './desktop-content';
import { FileManifest } from './file-manifest';

/** Internal, immutable file/conversation state. Its retaining owner determines lifetime;
 * it is not a Crux or a Growth edge, and reading it does not retain or mutate anything. */
export interface RetainedWorkspaceState {
  root: string;
  workspace: EditWorkspaceContext;
}

@Injectable()
export class WorkspaceStateService {
  constructor(
    private readonly content: FileContentService,
    private readonly files: FileContentRepository,
    private readonly crux: CruxGraphService,
  ) {}

  async read(
    input: FileContentSelection,
    store: DesktopContentStore,
    expectedMeta?: Record<string, unknown>,
    mergeId?: string,
  ): Promise<RetainedWorkspaceState> {
    const selected = captureFileContentSelection(input);
    const expected =
      expectedMeta === undefined ? undefined : captureMetadata(expectedMeta);
    const head = await this.content.admit(selected, mergeId);
    if (!head)
      throw new ConflictException(
        'Workspace recovery requires committed content',
      );
    const owner = await this.content.owner(selected.cruxId);
    if (
      expected !== undefined &&
      !isDeepStrictEqual(owner.meta ?? {}, expected)
    )
      throw new ConflictException(
        'The workspace changed before its state could be retained',
      );
    const edges = await this.crux.getDimensionsQuery(
      selected.cruxId,
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
    await this.assertContext(selected.cruxId, workspace);
    await new FileManifest(store).verify(head.root);
    return { root: head.root, workspace };
  }
  async assertContext(cruxId: string, workspace: EditWorkspaceContext) {
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
}
