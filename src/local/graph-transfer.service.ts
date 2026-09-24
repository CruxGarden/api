import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { RepositoryResponse } from '../common/types/interfaces';
import type { DesktopContentStore } from './desktop-content';
import { SelectedGraphService, GraphSelection } from './selected-graph.service';
import { GraphTransferRepository } from './graph-transfer.repository';
import {
  PrivateGraph,
  PrivateGraphImport,
  PrivateGraphImportResult,
  privateGraphSchema,
  projectPrivateGraph,
  remapGraphMeta,
} from './portable-graph';

const unwrap = <T>(result: RepositoryResponse<T>): T => {
  if (result.error) throw result.error;
  return result.data!;
};
const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function unique(values: string[], name: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${name} in private graph`);
}
function checkReferences(graph: PrivateGraph) {
  const owners = new Set(
    [...graph.cruxes, ...graph.workingCopies].map((row) => row.id),
  );
  const live = new Set(
    graph.cruxes.filter((row) => row.kind !== 'snapshot').map((row) => row.id),
  );
  const identities = [
    ...graph.cruxes,
    ...graph.workingCopies,
    ...graph.dimensions,
    ...graph.taskMerges,
    ...graph.store,
    ...graph.boundary,
  ].map((row) => row.id);
  identities.push(...graph.workingCopies.map((row) => row.taskId));
  unique(identities, 'identity');
  unique(graph.selection.roots, 'root');
  unique(
    graph.contentHeads.map((row) => row.cruxId),
    'content owner',
  );
  unique(graph.fingerprints, 'content fingerprint');
  const requireRef = (value: unknown, available = owners) => {
    if (typeof value !== 'string' || !available.has(value))
      throw new Error('Private graph has a missing or foreign typed reference');
  };
  for (const root of graph.selection.roots) requireRef(root, live);
  for (const row of [...graph.store, ...graph.contentHeads])
    requireRef(row.cruxId);
  for (const edge of graph.dimensions) {
    requireRef(edge.sourceId);
    requireRef(edge.targetId);
    if (
      edge.type === 'garden' &&
      edge.kind === 'membership' &&
      (!live.has(edge.targetId) ||
        graph.cruxes.find((row) => row.id === edge.sourceId)?.kind !== 'garden')
    )
      throw new Error('Invalid private Garden membership');
    if (
      edge.type === 'growth' &&
      !live.has(edge.sourceId) &&
      !graph.workingCopies.some((row) => row.id === edge.sourceId)
    )
      throw new Error('Invalid private Growth owner');
  }
  const membership = new Map<string, string[]>();
  for (const edge of graph.dimensions)
    if (edge.type === 'garden' && edge.kind === 'membership') {
      const children = membership.get(edge.sourceId) ?? [];
      if (children.includes(edge.targetId))
        throw new Error('Duplicate private Garden membership');
      children.push(edge.targetId);
      membership.set(edge.sourceId, children);
    }
  const visited = new Set<string>();
  const acyclic = (id: string, ancestors: Set<string>) => {
    if (ancestors.has(id))
      throw new Error('Private Garden membership contains a cycle');
    if (visited.has(id)) return;
    for (const child of membership.get(id) ?? [])
      acyclic(child, new Set([...ancestors, id]));
    visited.add(id);
  };
  for (const id of live) acyclic(id, new Set());
  for (const edge of graph.boundary) {
    requireRef(edge.sourceId);
    if (owners.has(edge.targetId) || edge.type === 'growth')
      throw new Error('Invalid private graph boundary');
  }
  for (const row of [...graph.workingCopies, ...graph.taskMerges])
    requireRef(row.cruxId, live);
  const allIds = new Set(identities);
  for (const row of [...graph.cruxes, ...graph.workingCopies]) {
    const meta = row.meta as Record<string, any>;
    const branch = meta.settings?.activeBranch;
    if (branch != null) {
      const snapshot = graph.cruxes.find((node) => node.id === branch);
      const copy = graph.workingCopies.find((node) => node.id === row.id);
      const contentOwner =
        copy?.baseSnapshotId === branch
          ? copy.cruxId
          : (meta.contentOwnerId ?? row.id);
      if (
        snapshot?.kind !== 'snapshot' ||
        snapshot.meta.contentOwnerId !== contentOwner
      )
        throw new Error(
          'Private graph active branch belongs to another content owner',
        );
    }

    for (const value of [
      meta.parentCruxId,
      meta.contentOwnerId,
      meta.settings?.activeBranch,
      ...['cruxId', 'taskId', 'baseSnapshotId'].map(
        (key) => meta.workingCopy?.[key],
      ),
      ...[
        'id',
        'taskId',
        'copyId',
        'baseId',
        'sourceHead',
        'targetHead',
        'resultHead',
      ].map((key) => meta.merge?.[key]),
      ...(Array.isArray(meta.messages)
        ? meta.messages.map((message) => message.taskMergeId)
        : []),
    ])
      if (value != null) requireRef(value, allIds);
  }
  return identities;
}

@Injectable()
export class GraphTransferService {
  constructor(
    private readonly selected: SelectedGraphService,
    private readonly repository: GraphTransferRepository,
  ) {}

  async exportPrivate(
    selection: GraphSelection,
    reader: DesktopContentStore,
  ): Promise<PrivateGraph> {
    const graph = projectPrivateGraph(
      await this.selected.capture(selection, reader),
    );
    const retained = unwrap(
      await this.repository.boundaries(
        [...graph.cruxes, ...graph.workingCopies].map((row) => row.id),
      ),
    );
    graph.boundary.push(...retained);
    privateGraphSchema.parse(graph);
    checkReferences(graph);
    return graph;
  }

  /** Called only inside the existing API transaction. Incoming reads are bound
   * to the archive; destination cache cannot hide an incomplete backup. */
  async importPrivate(
    input: PrivateGraphImport,
    incoming: DesktopContentStore,
    destination: DesktopContentStore,
  ): Promise<PrivateGraphImportResult> {
    const { graph, mode } = input;
    const identities = checkReferences(graph);
    const digest = hash(canonical(input));
    const receipt = unwrap(await this.repository.receipt(input.requestId));
    if (receipt) {
      if (receipt.digest !== digest)
        throw new Error('This import request ID belongs to different data');
      return receipt.result;
    }
    const ids = Object.fromEntries(
      identities.map((id) => [id, mode === 'copy' ? randomUUID() : id]),
    );
    unwrap(await this.repository.available(Object.values(ids)));
    const remap = (id: string) => ids[id];
    const cruxes = graph.cruxes.map((row) => ({
      ...row,
      id: remap(row.id),
      slug:
        mode === 'copy' && row.slug !== null
          ? `${row.slug}-${remap(row.id)}`
          : row.slug,
      ...input.destination,
      visibility: 'private',
      discoverable: false,
      meta: {
        ...remapGraphMeta(row.meta, ids),
        transferOrigin: row.meta.transferOrigin ?? {
          cruxId: row.id,
          authorId: row.authorId,
          homeId: row.homeId,
        },
      },
    }));
    const dimensions = graph.dimensions.map((row) => ({
      ...row,
      ...input.destination,
      id: remap(row.id),
      sourceId: remap(row.sourceId),
      targetId: remap(row.targetId),
    }));
    const copies = graph.workingCopies.map((row) => ({
      ...row,
      id: remap(row.id),
      cruxId: remap(row.cruxId),
      taskId: remap(row.taskId),
      baseSnapshotId: remap(row.baseSnapshotId),
      meta: remapGraphMeta(row.meta, ids),
      projectFolder: null,
      revision: 0,
      // A new host must prepare an editable folder before declaring setup ready.
      phase: ['merged', 'archived'].includes(row.phase)
        ? row.phase
        : 'preparing',
    }));
    const merges = graph.taskMerges.map((row) => {
      const data = { ...row.data };
      for (const key of [
        'id',
        'cruxId',
        'copyId',
        'candidateId',
        'sourceHead',
        'targetHead',
        'resultHead',
      ])
        if (data[key] != null) {
          if (typeof data[key] !== 'string' || !ids[data[key] as string])
            throw new Error('Private review has a missing typed reference');
          data[key] = remap(data[key] as string);
        }
      return {
        ...row,
        id: remap(row.id),
        cruxId: remap(row.cruxId),
        copyId: remap(row.copyId),
        candidateId: remap(row.candidateId),
        data: JSON.stringify(data),
      };
    });
    const store = graph.store.map((row) => ({
      ...row,
      id: remap(row.id),
      cruxId: remap(row.cruxId),
    }));
    const heads = graph.contentHeads.map((row) => ({
      ...row,
      cruxId: remap(row.cruxId),
    }));
    // These inserts are invisible until the outer transaction commits. Recapture
    // exercises exactly the same graph/Task/Growth/content invariants as export.
    for (const [table, rows] of [
      ['cruxes', cruxes],
      ['working_copies', copies],
      ['dimensions', dimensions],
      ['task_merges', merges],
      ['store', store],
      ['file_content_heads', heads],
    ] as const)
      unwrap(await this.repository.insert(table, rows));
    const captured = await this.selected.capture(
      {
        roots: graph.selection.roots.map(remap),
        includeMembers: graph.selection.includeMembers,
      },
      incoming,
    );
    for (const [expected, actual] of [
      [cruxes, captured.cruxes],
      [copies, captured.workingCopies],
      [dimensions, captured.dimensions],
      [merges, captured.taskMerges],
      [store, captured.store],
    ]) {
      const indexed = new Map(actual.map((row) => [row.id, row] as const));
      if (indexed.size !== expected.length)
        throw new Error(
          'Private graph contains unreachable or missing records',
        );
      for (const row of expected)
        for (const [key, value] of Object.entries(row))
          if (!isDeepStrictEqual(indexed.get(row.id)?.[key], value))
            throw new Error('Private graph changed during admission');
    }
    if (
      !isDeepStrictEqual(
        captured.contentHeads,
        [...heads].sort((a, b) => a.cruxId.localeCompare(b.cruxId)),
      ) ||
      !isDeepStrictEqual(
        captured.fingerprints,
        [...graph.fingerprints].sort(),
      ) ||
      captured.boundary.length
    )
      throw new Error(
        'Private graph content inventory is incomplete or contains unexpected objects',
      );
    for (const fp of captured.fingerprints) {
      const bytes = await incoming.read(fp);
      if (!(bytes instanceof Uint8Array) || hash(bytes) !== fp)
        throw new Error(
          `Incoming private content is missing or corrupt: ${fp}`,
        );
      // Capture mutable reader bytes before yielding to the destination writer.
      await destination.write(fp, Uint8Array.from(bytes));
      const persisted = await destination.read(fp);
      if (!(persisted instanceof Uint8Array) || hash(persisted) !== fp)
        throw new Error(`Imported private content did not persist: ${fp}`);
    }
    const result = {
      roots: graph.selection.roots.map(remap),
      ids,
      boundary: graph.boundary.map((edge) => ({
        ...edge,
        id: remap(edge.id),
        sourceId: remap(edge.sourceId),
      })),
    };
    unwrap(await this.repository.keepBoundaries(result.boundary));
    unwrap(await this.repository.remember(input.requestId, digest, result));
    const persisted = await this.selected.capture(
      {
        roots: result.roots,
        includeMembers: graph.selection.includeMembers,
      },
      destination,
    );
    if (!isDeepStrictEqual(persisted, captured))
      throw new Error('Imported graph changed before commit');
    return result;
  }
}
