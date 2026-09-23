import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'util';
import { CruxGraphService } from '../crux/crux-graph.service';
import { CreateCruxDto } from '../crux/dto/create-crux.dto';
import { DimensionService } from '../dimension/dimension.service';
import { DimensionType } from '../common/types/enums';
import { DesktopContentStore } from './desktop-content';
import {
  FileContentService,
  captureFileContentRead,
  FileContentSelection,
  captureFileContentSelection,
} from './file-content.service';
import { FileContentRepository } from './file-content.repository';
import { FileManifest } from './file-manifest';

export interface GrowthSnapshotCreate {
  cruxId: string;
  expected: { root: string; revision: number };
  snapshotId: string;
  parentId: string | null;
  title?: string;
  meta?: Record<string, unknown>;
  dimensionMeta?: Record<string, unknown>;
}

export interface GrowthContentRestore {
  safety: GrowthSnapshotCreate;
  target: FileContentSelection;
}

export function captureGrowthContentRestore(
  input: GrowthContentRestore,
): GrowthContentRestore {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'safety' && key !== 'target')
  )
    throw new Error('Use a Growth content restore request');
  return {
    safety: captureGrowthSnapshot(input.safety),
    target: captureFileContentSelection(input.target),
  };
}

function captureMetadata(value: unknown): Record<string, unknown> {
  const seen = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (
      !item ||
      typeof item !== 'object' ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new Error('Use finite JSON metadata');
    if (seen.has(item)) throw new Error('Use acyclic JSON metadata');
    seen.add(item);
    if (Array.isArray(item))
      for (let i = 0; i < item.length; i++) check(item[i]);
    else for (const entry of Object.values(item)) check(entry);
    seen.delete(item);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Use a metadata object');
  check(value);
  return JSON.parse(JSON.stringify(value));
}

export function captureGrowthSnapshot(
  input: GrowthSnapshotCreate,
): GrowthSnapshotCreate {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use a Growth snapshot request');
  const allowed = new Set([
    'cruxId',
    'expected',
    'snapshotId',
    'parentId',
    'title',
    'meta',
    'dimensionMeta',
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new Error(`Unsupported Growth field: ${key}`);
  const captured = captureFileContentRead({
    cruxId: input.cruxId,
    expected: input.expected,
    path: 'snapshot',
  });
  if (
    typeof input.snapshotId !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.snapshotId) ||
    input.snapshotId === input.cruxId ||
    (input.parentId !== null &&
      (typeof input.parentId !== 'string' || !input.parentId)) ||
    (input.title !== undefined && typeof input.title !== 'string')
  )
    throw new Error('Use a new snapshot identity and an explicit parent');
  const meta = captureMetadata(input.meta ?? {});
  for (const key of [
    'contentOwnerId',
    'parentCruxId',
    'workingCopy',
    'projectFolder',
  ])
    if (key in meta) throw new Error(`Snapshot ${key} is owned by the API`);
  return {
    cruxId: captured.cruxId,
    expected: captured.expected,
    snapshotId: input.snapshotId,
    parentId: input.parentId,
    title: input.title,
    meta,
    dimensionMeta: captureMetadata(input.dimensionMeta ?? {}),
  };
}

/** A snapshot node, its content head and its Growth edge commit in one owner transaction. */
@Injectable()
export class GrowthContentService {
  constructor(
    private readonly crux: CruxGraphService,
    private readonly dimension: DimensionService,
    private readonly content: FileContentService,
    private readonly repository: FileContentRepository,
  ) {}

  /** The caller runs this entire operation in the API owner transaction.
   * Folder projection and workspace presentation state are separate consumers. */
  async restore(input: GrowthContentRestore, store: DesktopContentStore) {
    await this.content.admit(input.safety);
    const source = await this.crux.findById(input.safety.cruxId);
    const target = await this.crux.findById(input.target.cruxId);
    const targetHead = await this.content.head(target.id);
    const edges = await this.crux.getDimensionsQuery(
      source.id,
      DimensionType.GROWTH,
      false,
      false,
    );
    if (
      target.kind !== 'snapshot' ||
      target.deleted ||
      target.meta?.contentOwnerId !== source.id ||
      target.authorId !== source.authorId ||
      target.homeId !== source.homeId ||
      !edges.some((edge) => edge.target_id === target.id) ||
      !targetHead ||
      targetHead.formatVersion !== 1 ||
      targetHead.revision !== 1 ||
      targetHead.root !== input.target.expected.root ||
      targetHead.revision !== input.target.expected.revision
    )
      throw new ConflictException(
        'Restore requires the selected retained snapshot of this Crux',
      );
    // Validate the destination before creating even the temporary safety node.
    await new FileManifest(store).verify(targetHead.root);
    const safety = await this.create(input.safety, store);
    const head = await this.content.commit(
      {
        cruxId: source.id,
        expected: input.safety.expected,
        root: targetHead.root,
      },
      store,
    );
    // Publication must not alter either retained snapshot via a late database write.
    if (
      !isDeepStrictEqual(
        await this.content.head(safety.snapshot.id),
        safety.head,
      ) ||
      !isDeepStrictEqual(
        await this.crux.findById(safety.snapshot.id),
        safety.snapshot,
      ) ||
      !isDeepStrictEqual(
        await this.dimension.findById(safety.growth.id),
        safety.growth,
      ) ||
      !isDeepStrictEqual(await this.content.head(target.id), targetHead) ||
      !isDeepStrictEqual(await this.crux.findById(target.id), target)
    )
      throw new InternalServerErrorException(
        'Restored snapshot retention did not persist',
      );
    return { safety, head };
  }

  async create(input: GrowthSnapshotCreate, store: DesktopContentStore) {
    const sourceHead = await this.content.admit(input);
    if (!sourceHead)
      throw new ConflictException('Growth requires committed file content');
    const source = await this.crux.findById(input.cruxId);
    const edges = await this.crux.getDimensionsQuery(
      input.cruxId,
      DimensionType.GROWTH,
      false,
      false,
    );
    if (input.parentId !== null) {
      const parentEdge = edges.find(
        (edge) => edge.target_id === input.parentId,
      );
      if (!parentEdge)
        throw new ConflictException('Growth parent must belong to this Crux');
      const parent = await this.crux.findById(input.parentId);
      const parentHead = await this.content.head(input.parentId);
      if (
        parent.kind !== 'snapshot' ||
        parent.deleted ||
        parent.meta?.contentOwnerId !== source.id ||
        !parentHead ||
        parentHead.formatVersion !== 1 ||
        !/^[a-f0-9]{64}$/.test(parentHead.root) ||
        !Number.isSafeInteger(parentHead.revision) ||
        parentHead.revision < 1
      )
        throw new ConflictException(
          'Growth parent requires a retained snapshot',
        );
    }
    const weight =
      edges.reduce(
        (highest, edge) => Math.max(highest, Number(edge.weight ?? 0)),
        0,
      ) + 1;
    if (!Number.isSafeInteger(weight) || weight < 1)
      throw new ConflictException('Invalid Growth ordering');
    await new FileManifest(store).verify(sourceHead.root);
    const data = {
      id: input.snapshotId,
      slug: `snapshot-${input.snapshotId}`,
      title: input.title ?? source.title ?? 'Snapshot',
      authorId: source.authorId,
      homeId: source.homeId,
      type: 'crux',
      kind: 'snapshot',
      meta: {
        ...input.meta,
        contentOwnerId: source.id,
        parentCruxId: input.parentId,
      },
    };
    await this.crux.create(data as CreateCruxDto);
    let snapshot = await this.crux.findById(data.id);
    if (
      snapshot.id !== data.id ||
      snapshot.kind !== data.kind ||
      snapshot.title !== data.title ||
      snapshot.authorId !== data.authorId ||
      snapshot.homeId !== data.homeId ||
      snapshot.visibility !== 'private' ||
      snapshot.deleted ||
      !isDeepStrictEqual(snapshot.meta, data.meta)
    )
      throw new InternalServerErrorException(
        'Snapshot creation did not persist',
      );
    const retained = { ...sourceHead, cruxId: snapshot.id, revision: 1 };
    const published = await this.repository.publish(retained, null);
    if (published.error)
      throw new InternalServerErrorException(published.error.message);
    const relation = {
      sourceId: source.id,
      targetId: snapshot.id,
      type: 'growth',
      weight,
      authorId: source.authorId,
      homeId: source.homeId,
      meta: input.dimensionMeta,
    };
    const created = await this.dimension.create(relation);
    const growth = await this.dimension.findById(created.id);
    if (
      growth.sourceId !== relation.sourceId ||
      growth.targetId !== relation.targetId ||
      growth.type !== relation.type ||
      growth.weight !== weight ||
      growth.authorId !== relation.authorId ||
      growth.homeId !== relation.homeId ||
      growth.deleted ||
      !isDeepStrictEqual(growth.meta, relation.meta)
    )
      throw new InternalServerErrorException('Growth creation did not persist');
    // A late write (including a database trigger) must not corrupt earlier parts
    // of this command while leaving a seemingly successful Dimension result.
    snapshot = await this.crux.findById(data.id);
    const savedHead = await this.content.head(data.id);
    if (
      !isDeepStrictEqual(savedHead, retained) ||
      !isDeepStrictEqual(snapshot.meta, data.meta) ||
      snapshot.kind !== 'snapshot' ||
      snapshot.deleted ||
      snapshot.authorId !== data.authorId ||
      snapshot.homeId !== data.homeId ||
      snapshot.title !== data.title ||
      snapshot.visibility !== 'private'
    )
      throw new InternalServerErrorException(
        'Snapshot retention did not persist',
      );
    return { snapshot, growth, head: retained };
  }
}
