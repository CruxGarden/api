import {
  copySourceChain,
  copyParentOwner,
  CopySource,
} from './working-copy-base';
import { retainedWorkspaceSchema, editWorkspaceSchema } from './edit-history';
import {
  GardenMembershipService,
  assertSinglePlacement,
} from './garden-membership.service';
import { packPrivateGraph } from './private-graph-archive';
import type { SelectedGraphCapture } from './selected-graph.service';
import { isAbsolute, resolve } from 'path';
import { FileManifest } from './file-manifest';
import type { PrepareImportedWorkspace } from './import-workspace';
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
  unique(
    (graph.editHistory ?? []).map((row) => row.cruxId),
    'edit history owner',
  );
  unique(graph.fingerprints, 'content fingerprint');
  const sourceCopies = new Map(
    graph.workingCopies.map((copy) => [copy.id, copy]),
  ) as unknown as ReadonlyMap<string, CopySource>;
  for (const copy of graph.workingCopies)
    copySourceChain(copy.id, sourceCopies);
  const requireRef = (value: unknown, available = owners) => {
    if (typeof value !== 'string' || !available.has(value))
      throw new Error('Private graph has a missing or foreign typed reference');
  };
  for (const root of graph.selection.roots) requireRef(root, live);
  for (const row of [...graph.store, ...graph.contentHeads])
    requireRef(row.cruxId);
  for (const row of graph.editHistory ?? []) {
    requireRef(
      row.cruxId,
      new Set([...live, ...graph.workingCopies.map((copy) => copy.id)]),
    );
    unique(
      row.checkpoints.map((item) => item.id),
      'edit checkpoint',
    );
    for (const checkpoint of row.checkpoints) {
      const parentId = checkpoint.workspace?.parentId;
      if (!parentId) continue;
      const parentOwner = copyParentOwner(row.cruxId, parentId, sourceCopies);
      const parent = graph.cruxes.find((item) => item.id === parentId);
      if (
        !parent ||
        parent.kind !== 'snapshot' ||
        parent.meta.contentOwnerId !== parentOwner ||
        !graph.dimensions.some(
          (edge) =>
            edge.type === 'growth' &&
            edge.sourceId === parentOwner &&
            edge.targetId === parentId,
        )
      )
        throw new Error(
          'Private recovery has a missing or foreign Growth context',
        );
    }
  }
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
      const contentOwner = copyParentOwner(
        meta.contentOwnerId ?? row.id,
        branch,
        sourceCopies,
      );
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
      ...['cruxId', 'taskId', 'baseParentId'].map(
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
  for (const copy of graph.workingCopies) {
    const { parentId, messages } = copy.baseState.workspace;
    if (copy.baseState.sourceId) requireRef(copy.baseState.sourceId);
    const parentOwner = parentId
      ? copyParentOwner(copy.id, parentId, sourceCopies)
      : null;
    if (parentId) {
      const parent = graph.cruxes.find((row) => row.id === parentId);
      if (
        parent?.kind !== 'snapshot' ||
        parent.meta.contentOwnerId !== parentOwner ||
        !graph.dimensions.some(
          (edge) =>
            edge.type === 'growth' &&
            edge.sourceId === parentOwner &&
            edge.targetId === parentId,
        )
      )
        throw new Error(
          'Private Task starting state has foreign Growth context',
        );
    }
    for (const message of messages as any[])
      if (message?.taskMergeId != null) requireRef(message.taskMergeId, allIds);
  }
  for (const merge of graph.taskMerges) {
    const source = sourceCopies.get(merge.copyId),
      candidate = sourceCopies.get(merge.candidateId);
    const targetId = source?.baseState.sourceId ?? merge.cruxId;
    if (
      !source ||
      source.cruxId !== merge.cruxId ||
      source.role !== 'task' ||
      !candidate ||
      candidate.cruxId !== merge.cruxId ||
      candidate.role !== 'review' ||
      (candidate.baseState.sourceId ?? merge.cruxId) !== targetId ||
      (merge.data.targetId !== undefined && merge.data.targetId !== targetId)
    )
      throw new Error('Private review destination does not match its source');
    requireRef(targetId);
    for (const [key, owner] of [
      ['sourceState', merge.copyId],
      ['targetState', targetId],
      ['resultState', targetId],
    ]) {
      if (merge.data[key] === undefined) continue;
      const parentId = retainedWorkspaceSchema.parse(merge.data[key]).workspace
        .parentId;
      if (!parentId) continue;
      const parent = graph.cruxes.find((item) => item.id === parentId);
      const parentOwner = copyParentOwner(owner, parentId, sourceCopies);
      if (
        parent?.kind !== 'snapshot' ||
        parent.meta.contentOwnerId !== parentOwner ||
        !graph.dimensions.some(
          (edge) =>
            edge.type === 'growth' &&
            edge.sourceId === parentOwner &&
            edge.targetId === parentId,
        )
      )
        throw new Error('Private review has foreign workspace context');
    }
    for (const workspace of [
      ...['sourceState', 'targetState'].map((key) =>
        merge.data[key] === undefined
          ? undefined
          : retainedWorkspaceSchema.parse(merge.data[key]).workspace,
      ),
      merge.data.resultState === undefined
        ? undefined
        : retainedWorkspaceSchema.parse(merge.data.resultState).workspace,
      merge.data.targetWorkspace === undefined
        ? undefined
        : editWorkspaceSchema.parse(merge.data.targetWorkspace),
    ]) {
      if (!workspace) continue;
      if (workspace.parentId) requireRef(workspace.parentId);
      for (const message of workspace.messages as Record<string, unknown>[])
        if (message?.taskMergeId !== undefined)
          requireRef(message.taskMergeId, allIds);
    }
  }
  return identities;
}

@Injectable()
export class GraphTransferService {
  constructor(
    private readonly selected: SelectedGraphService,
    private readonly repository: GraphTransferRepository,
    private readonly garden: GardenMembershipService,
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

  async replacementToken(
    selection: GraphSelection,
    store: DesktopContentStore,
  ) {
    return hash(canonical(await this.selected.capture(selection, store)));
  }

  /** Called only inside the existing API transaction. Incoming reads are bound
   * to the archive; destination cache cannot hide an incomplete backup. */
  async importPrivate(
    input: PrivateGraphImport,
    incoming: DesktopContentStore,
    destination: DesktopContentStore,
    prepare?: PrepareImportedWorkspace,
  ): Promise<PrivateGraphImportResult> {
    const { graph, mode } = input;
    const identities = checkReferences(graph);
    // The token guards first admission; a retry may obtain a fresh token after
    // the original request committed. Identity still binds the exact archive.
    const operation = { ...input };
    delete operation.replacementToken;
    const digest = hash(canonical({ input: operation, folders: !!prepare }));
    const receipt = unwrap(await this.repository.receipt(input.requestId));
    if (receipt) {
      if (receipt.digest !== digest)
        throw new Error('This import request ID belongs to different data');
      return receipt.result;
    }
    assertSinglePlacement(
      graph.dimensions
        .filter((edge) => edge.type === 'garden' && edge.kind === 'membership')
        .map((edge) => ({
          sourceId: edge.sourceId!,
          targetId: edge.targetId!,
        })),
    );
    const ids = Object.fromEntries(
      identities.map((id) => [id, mode === 'copy' ? randomUUID() : id]),
    );
    let previous: SelectedGraphCapture | undefined;
    let safetyArchive: string | undefined;
    let external: Record<string, any>[] = [];
    if (mode === 'replace') {
      previous = await this.selected.capture(
        {
          roots: graph.selection.roots,
          includeMembers: graph.selection.includeMembers,
        },
        destination,
      );
      if (hash(canonical(previous)) !== input.replacementToken)
        throw new Error(
          'This Crux changed while preparing replacement. Reopen and retry.',
        );
      const retained = new Set(
        [...graph.cruxes, ...graph.workingCopies].map((row) => row.id),
      );
      external = unwrap(
        await this.repository.replacementBoundary(previous, retained),
      );
      for (const edge of external) {
        const descriptor = graph.boundary.find((row) => row.id === edge.id);
        if (
          identities.includes(edge.id) &&
          (!descriptor ||
            ['sourceId', 'targetId', 'type', 'kind'].some(
              (key) => descriptor[key] !== edge[key],
            ))
        )
          throw new Error(
            'Replacement conflicts with an existing external connection',
          );
      }
      const backup = await packPrivateGraph(
        await this.exportPrivate(
          {
            roots: graph.selection.roots,
            includeMembers: graph.selection.includeMembers,
          },
          destination,
        ),
        destination,
      );
      safetyArchive = hash(backup);
      await destination.write(safetyArchive, backup);
      const saved = await destination.read(safetyArchive);
      if (!(saved instanceof Uint8Array) || hash(saved) !== safetyArchive)
        throw new Error('The replacement safety archive did not persist');
      unwrap(await this.repository.replaceSelection(previous));
    }
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
      baseState: JSON.stringify({
        ...row.baseState,
        ...(row.baseState.sourceId
          ? { sourceId: remap(row.baseState.sourceId) }
          : {}),
        workspace: {
          ...row.baseState.workspace,
          parentId: row.baseState.workspace.parentId
            ? remap(row.baseState.workspace.parentId)
            : null,
          messages: remapGraphMeta(
            { messages: row.baseState.workspace.messages },
            ids,
          ).messages,
        },
      }),
      meta: remapGraphMeta(row.meta, ids),
      projectFolder: null,
      revision:
        mode === 'replace'
          ? (previous?.workingCopies.find((copy) => copy.id === row.id)
              ?.revision ?? -1) + 1
          : 0,
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
        'targetId',
        'sourceHead',
        'targetHead',
        'resultHead',
      ])
        if (data[key] != null) {
          if (typeof data[key] !== 'string' || !ids[data[key] as string])
            throw new Error('Private review has a missing typed reference');
          data[key] = remap(data[key] as string);
        }
      for (const key of ['sourceState', 'targetState', 'resultState']) {
        if (data[key] === undefined) continue;
        const result = retainedWorkspaceSchema.parse(data[key]);
        if (result.workspace.parentId && !ids[result.workspace.parentId])
          throw new Error('Private Task result has a missing parent');
        data[key] = {
          ...result,
          workspace: {
            ...result.workspace,
            parentId: result.workspace.parentId
              ? remap(result.workspace.parentId)
              : null,
            messages: remapGraphMeta(
              { messages: result.workspace.messages },
              ids,
            ).messages,
          },
        };
      }
      if (data.targetWorkspace !== undefined) {
        const target = editWorkspaceSchema.parse(data.targetWorkspace);
        if (target.parentId && !ids[target.parentId])
          throw new Error('Private Task target has a missing parent');
        data.targetWorkspace = {
          ...target,
          parentId: target.parentId ? remap(target.parentId) : null,
          messages: remapGraphMeta({ messages: target.messages }, ids).messages,
        };
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
      revision:
        mode === 'replace' &&
        graph.cruxes.find((node) => node.id === row.cruxId)?.kind !== 'snapshot'
          ? Math.max(
              row.revision,
              previous?.contentHeads.find((head) => head.cruxId === row.cruxId)
                ?.revision ?? 0,
            ) + 1
          : row.revision,
    }));
    const editHistory = (graph.editHistory ?? []).map((row) => ({
      ...row,
      cruxId: remap(row.cruxId),
      revision:
        mode === 'replace'
          ? Math.max(
              row.revision,
              previous?.editHistory.find((item) => item.cruxId === row.cruxId)
                ?.revision ?? 0,
            ) + 1
          : row.revision,
      checkpoints: row.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        id: mode === 'copy' ? randomUUID() : checkpoint.id,
        ...(checkpoint.workspace
          ? {
              workspace: {
                ...checkpoint.workspace,
                parentId: checkpoint.workspace.parentId
                  ? remap(checkpoint.workspace.parentId)
                  : null,
                messages: remapGraphMeta(
                  { messages: checkpoint.workspace.messages },
                  ids,
                ).messages,
              },
            }
          : {}),
      })),
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
      [
        'edit_history',
        editHistory.map((row) => ({
          ...row,
          checkpoints: JSON.stringify(row.checkpoints),
        })),
      ],
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
          if (
            !isDeepStrictEqual(
              indexed.get(row.id)?.[key],
              key === 'baseState' && typeof value === 'string'
                ? JSON.parse(value)
                : value,
            )
          )
            throw new Error('Private graph changed during admission');
    }
    if (
      !isDeepStrictEqual(
        captured.editHistory,
        [...editHistory].sort((a, b) => a.cruxId.localeCompare(b.cruxId)),
      )
    )
      throw new Error('Edit history changed during admission');
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
    if (prepare) {
      const manifest = new FileManifest(destination);
      const folders = new Set<string>(
        [...(previous?.cruxes ?? []), ...(previous?.workingCopies ?? [])]
          .map((row) => row.projectFolder ?? row.meta?.projectFolder)
          .filter((folder): folder is string => typeof folder === 'string')
          .map((folder) => resolve(folder)),
      );
      for (const workspace of [
        ...captured.cruxes.filter((row) => row.kind !== 'snapshot'),
        ...captured.workingCopies,
      ]) {
        const isCopy = captured.workingCopies.some(
          (row) => row.id === workspace.id,
        );
        const head =
          captured.contentHeads.find((row) => row.cruxId === workspace.id) ??
          null;
        const folder = await prepare(
          JSON.parse(
            JSON.stringify({
              id: workspace.id,
              slug: isCopy ? `task-${workspace.id}` : workspace.slug,
              kind: isCopy ? null : workspace.kind,
              role: isCopy ? workspace.role : 'main',
              head,
              files: head ? await manifest.entries(head.root) : [],
            }),
          ),
        );
        if (
          typeof folder !== 'string' ||
          !isAbsolute(folder) ||
          folders.has(resolve(folder))
        )
          throw new Error(
            'Imported workspaces require separate absolute Project folder paths',
          );
        const resolved = resolve(folder);
        folders.add(resolved);
        if (isCopy) {
          workspace.projectFolder = resolved;
          if (workspace.phase === 'preparing') workspace.phase = 'ready';
        } else workspace.meta = { ...workspace.meta, projectFolder: resolved };
        unwrap(await this.repository.bindFolder(workspace, isCopy));
      }
    }
    const result = {
      roots: graph.selection.roots.map(remap),
      ids,
      ...(safetyArchive ? { safetyArchive } : {}),
      boundary: graph.boundary
        .filter((edge) => !external.some((local) => local.id === edge.id))
        .map((edge) => ({
          ...edge,
          id: remap(edge.id),
          sourceId: remap(edge.sourceId),
        })),
    };
    if (external.length) {
      unwrap(await this.repository.insert('dimensions', external));
      const boundaryIds = new Set(external.map((row) => row.id));
      captured.boundary = previous!.boundary.filter((row) =>
        boundaryIds.has(row.id),
      );
    }
    unwrap(await this.repository.keepBoundaries(result.boundary));
    unwrap(await this.repository.remember(input.requestId, digest, result));
    const persisted = await this.selected.capture(
      {
        roots: result.roots,
        includeMembers: graph.selection.includeMembers,
      },
      destination,
    );
    if (safetyArchive) {
      const bytes = await destination.read(safetyArchive);
      if (!(bytes instanceof Uint8Array) || hash(bytes) !== safetyArchive)
        throw new Error(
          'The replacement safety archive was lost before commit',
        );
    }
    if (!isDeepStrictEqual(persisted, captured))
      throw new Error('Imported graph changed before commit');
    if (input.gardenId) {
      for (const memberId of result.roots)
        await this.garden.add({
          gardenId: input.gardenId,
          memberId,
          authorId: input.destination.authorId,
          homeId: input.destination.homeId,
        });
    }
    return result;
  }
}
