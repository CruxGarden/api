import {
  retainedWorkspaceSchema,
  parseEditHistory,
  EditHistory,
} from './edit-history';
import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { RepositoryResponse } from '../common/types/interfaces';
import type { DesktopContentStore } from './desktop-content';
import { FileManifest } from './file-manifest';
import type { FileContentHead } from './file-content.repository';
import {
  SelectedGraphRepository,
  CapturedRecord,
} from './selected-graph.repository';

export interface GraphSelection {
  roots: string[];
  /** Traverse only explicit Garden membership, never Gate/Graft/derivation. */
  includeMembers: boolean;
}

/** Trusted host checkpoint, NOT a portable sharing envelope: private metadata,
 * folder registrations and completed operational records are retained here.
 * A portable projection/import contract must remove installation state before transport. */
export interface SelectedGraphCapture {
  selection: GraphSelection;
  cruxes: CapturedRecord[];
  dimensions: CapturedRecord[];
  workingCopies: CapturedRecord[];
  taskMerges: CapturedRecord[];
  store: CapturedRecord[];
  contentHeads: FileContentHead[];
  editHistory: EditHistory[];
  boundary: {
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    kind: string | null;
    state: 'outside-selection' | 'unavailable';
  }[];
  fingerprints: string[];
}

export function captureGraphSelection(input: GraphSelection): GraphSelection {
  if (
    !input ||
    !Array.isArray(input.roots) ||
    !input.roots.length ||
    typeof input.includeMembers !== 'boolean' ||
    Object.keys(input).some(
      (key) => key !== 'roots' && key !== 'includeMembers',
    ) ||
    input.roots.some((id) => typeof id !== 'string' || !isUUID(id))
  )
    throw new Error(
      'Select explicit Crux roots and a Garden membership policy',
    );
  return {
    roots: [...new Set(input.roots)].sort(),
    includeMembers: input.includeMembers,
  };
}

function unwrap<T>(result: RepositoryResponse<T>): T {
  if (result.error) throw result.error;
  return result.data!;
}

const sorted = (rows: CapturedRecord[]) =>
  rows.sort((a, b) => a.id.localeCompare(b.id));
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid selected graph metadata');
  return value as Record<string, any>;
};

@Injectable()
export class SelectedGraphService {
  constructor(private readonly repository: SelectedGraphRepository) {}

  async capture(
    selection: GraphSelection,
    store: DesktopContentStore,
  ): Promise<SelectedGraphCapture> {
    const nodes = new Map<string, CapturedRecord>();
    const live = new Set<string>();
    const membership = new Map<string, string[]>();
    const edges = new Map<string, CapturedRecord>();
    const visit = async (id: string, ancestors: Set<string>) => {
      if (ancestors.has(id))
        throw new Error('Selected Garden membership contains a cycle');
      if (live.has(id)) return;
      const node = unwrap(await this.repository.node(id));
      if (!node || node.deleted || node.kind === 'snapshot')
        throw new Error(
          'Select an available Garden or Crux, not retained Growth',
        );
      nodes.set(id, node);
      live.add(id);
      const outgoing = unwrap(await this.repository.rows('dimensions', [id]));
      for (const edge of outgoing) edges.set(edge.id, edge);
      if (!selection.includeMembers) return;
      const members = outgoing.filter(
        (edge) => edge.type === 'garden' && edge.kind === 'membership',
      );
      if (members.length && node.kind !== 'garden')
        throw new Error('Garden membership must originate at a Garden');
      membership.set(
        id,
        members.map((edge) => edge.targetId),
      );
      for (const member of members)
        await visit(member.targetId, new Set([...ancestors, id]));
    };
    for (const id of selection.roots) await visit(id, new Set());
    // A DAG can reach an already visited node on another path; validate the
    // complete selected membership subgraph independently of traversal order.
    const checked = new Set<string>();
    const acyclic = (id: string, path: Set<string>) => {
      if (path.has(id))
        throw new Error('Selected Garden membership contains a cycle');
      if (checked.has(id)) return;
      for (const child of membership.get(id) ?? [])
        acyclic(child, new Set([...path, id]));
      checked.add(id);
    };
    for (const id of live) acyclic(id, new Set());

    const workingCopies: CapturedRecord[] = unwrap(
      await this.repository.rows('working_copies', [...live]),
    ).map((copy) => ({
      ...copy,
      baseState: retainedWorkspaceSchema.parse(JSON.parse(copy.baseState)),
    }));
    const copies = new Map(workingCopies.map((copy) => [copy.id, copy]));
    for (const copy of workingCopies) {
      if (nodes.has(copy.id) || !['task', 'review'].includes(copy.role))
        throw new Error('Invalid selected Working Copy identity');
    }
    for (const edge of unwrap(
      await this.repository.rows('dimensions', [...copies.keys()]),
    ))
      edges.set(edge.id, edge);
    for (const edge of [...edges.values()]) {
      if (edge.type !== 'growth') continue;
      const snapshot = unwrap(await this.repository.node(edge.targetId));
      if (
        !snapshot ||
        snapshot.deleted ||
        snapshot.kind !== 'snapshot' ||
        object(snapshot.meta).contentOwnerId !== edge.sourceId ||
        live.has(snapshot.id)
      )
        throw new Error('Selected Growth has a missing or mismatched snapshot');
      nodes.set(snapshot.id, snapshot);
    }
    const selected = new Set([...nodes.keys(), ...copies.keys()]);
    for (const node of nodes.values()) {
      if (node.kind !== 'snapshot') continue;
      const parentId = object(node.meta).parentCruxId;
      if (parentId != null) {
        const parent = nodes.get(parentId);
        const contentOwner = node.meta.contentOwnerId;
        const copy = copies.get(contentOwner);
        const parentOwner =
          copy?.baseState.workspace.parentId === parentId
            ? copy.cruxId
            : contentOwner;
        if (
          !parent ||
          parent.kind !== 'snapshot' ||
          parent.meta.contentOwnerId !== parentOwner
        )
          throw new Error(
            'Selected Growth ancestry is incomplete or belongs to another owner',
          );
      }
    }
    const checkedGrowth = new Set<string>();
    const checkGrowth = (id: string, visiting: Set<string>) => {
      if (visiting.has(id))
        throw new Error('Selected Growth ancestry contains a cycle');
      if (checkedGrowth.has(id)) return;
      const parent = nodes.get(id)?.meta?.parentCruxId;
      if (parent != null) checkGrowth(parent, new Set([...visiting, id]));
      checkedGrowth.add(id);
    };
    for (const node of nodes.values())
      if (node.kind === 'snapshot') checkGrowth(node.id, new Set());
    for (const copy of workingCopies) {
      const parentId = copy.baseState.workspace.parentId;
      if (!parentId) continue;
      const base = nodes.get(parentId);
      if (
        !base ||
        base.kind !== 'snapshot' ||
        base.meta.contentOwnerId !== copy.cruxId
      )
        throw new Error(
          'Selected Task base is missing or belongs to another Crux',
        );
    }
    // Capture outgoing snapshot relationships too; never traverse them implicitly.
    for (const edge of unwrap(
      await this.repository.rows(
        'dimensions',
        [...nodes.keys()].filter((id) => !live.has(id)),
      ),
    ))
      edges.set(edge.id, edge);
    const dimensions: CapturedRecord[] = [];
    const boundary: SelectedGraphCapture['boundary'] = [];
    for (const edge of sorted([...edges.values()])) {
      if (!['gate', 'garden', 'growth', 'graft'].includes(edge.type))
        throw new Error('Unsupported selected Dimension type');
      if (selected.has(edge.targetId)) dimensions.push(edge);
      else {
        const available = unwrap(
          await this.repository.targetAvailable(edge.targetId),
        );
        boundary.push({
          id: edge.id,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          type: edge.type,
          kind: edge.kind ?? null,
          state: available ? 'outside-selection' : 'unavailable',
        });
      }
    }
    const taskMerges = unwrap(
      await this.repository.rows('task_merges', [...live]),
    );
    if (taskMerges.some((merge) => merge.phase === 'applying'))
      throw new Error(
        'Recover the selected Task merge before capturing its graph',
      );
    const resultRoots: string[] = [];
    for (const merge of taskMerges) {
      if (
        copies.get(merge.copyId)?.cruxId !== merge.cruxId ||
        copies.get(merge.candidateId)?.cruxId !== merge.cruxId ||
        copies.get(merge.copyId)?.role !== 'task' ||
        copies.get(merge.candidateId)?.role !== 'review'
      )
        throw new Error(
          'Selected Task review references a missing or foreign Working Copy',
        );
      const data = object(
        typeof merge.data === 'string' ? JSON.parse(merge.data) : merge.data,
      );
      if (
        !['review', 'merged', 'cancelled'].includes(merge.phase) ||
        ['id', 'cruxId', 'copyId', 'candidateId', 'phase'].some(
          (key) => data[key] !== merge[key],
        )
      )
        throw new Error(
          'Selected Task review identity or phase is inconsistent',
        );
      if (data.resultState !== undefined) {
        const result = retainedWorkspaceSchema.parse(data.resultState);
        if (merge.phase !== 'merged' || data.resultHead !== undefined)
          throw new Error('Selected Task result has inconsistent retention');
        const parent =
          result.workspace.parentId && nodes.get(result.workspace.parentId);
        if (
          result.workspace.parentId &&
          (!parent ||
            parent.kind !== 'snapshot' ||
            parent.meta.contentOwnerId !== merge.cruxId)
        )
          throw new Error('Selected Task result has foreign Growth context');
        resultRoots.push(result.root);
      }
      for (const [key, contentOwner] of [
        ['sourceState', merge.copyId],
        ['targetState', merge.cruxId],
      ]) {
        // Retain older recorded journals without inventing review context for them.
        if (
          data[key] === undefined &&
          typeof data.sourceHead === 'string' &&
          typeof data.targetHead === 'string'
        )
          continue;
        const retained = retainedWorkspaceSchema.parse(data[key]);
        const parentId = retained.workspace.parentId;
        const parent = parentId && nodes.get(parentId);
        const task = workingCopies.find((copy) => copy.id === merge.copyId);
        if (
          parentId &&
          (!parent ||
            parent.kind !== 'snapshot' ||
            (parent.meta.contentOwnerId !== contentOwner &&
              !(
                key === 'sourceState' &&
                parentId === task?.baseState.workspace.parentId &&
                parent.meta.contentOwnerId === merge.cruxId
              )))
        )
          throw new Error(
            'Selected Task review has foreign conversation context',
          );
        resultRoots.push(retained.root);
      }
      for (const [key, contentOwner] of [
        ['sourceHead', merge.copyId],
        ['targetHead', merge.cruxId],
        ['resultHead', merge.cruxId],
      ]) {
        if (data[key] == null) continue;
        const snapshot = nodes.get(data[key]);
        if (
          !snapshot ||
          snapshot.kind !== 'snapshot' ||
          snapshot.meta.contentOwnerId !== contentOwner
        )
          throw new Error(
            'Selected Task review has a missing or foreign Growth reference',
          );
      }
    }
    unwrap(await this.repository.contentAvailable([...selected]));
    const contentHeads = unwrap(
      await this.repository.rows('file_content_heads', [...selected]),
    );
    const heads = new Map(contentHeads.map((head) => [head.cruxId, head]));
    for (const node of [...nodes.values(), ...workingCopies]) {
      if (
        (node.kind === 'snapshot' || copies.has(node.id)) &&
        !heads.has(node.id)
      )
        throw new Error(
          'Selected history or Task has no retained content head',
        );
    }
    const editHistory = unwrap(
      await this.repository.rows('edit_history', [...selected]),
    ).map((row) =>
      parseEditHistory({
        cruxId: row.cruxId,
        revision: row.revision,
        checkpoints:
          typeof row.checkpoints === 'string'
            ? JSON.parse(row.checkpoints)
            : row.checkpoints,
      }),
    );
    for (const history of editHistory) {
      if (nodes.get(history.cruxId)?.kind === 'snapshot')
        throw new Error('Growth cannot own mutable edit history');
      for (const checkpoint of history.checkpoints) {
        const parentId = checkpoint.workspace?.parentId;
        if (!parentId) continue;
        const copy = workingCopies.find((item) => item.id === history.cruxId);
        const parentOwner =
          copy?.baseState.workspace.parentId === parentId
            ? copy.cruxId
            : history.cruxId;
        const parent = nodes.get(parentId);
        if (
          !parent ||
          parent.kind !== 'snapshot' ||
          parent.meta.contentOwnerId !== parentOwner ||
          !dimensions.some(
            (edge) =>
              edge.type === 'growth' &&
              edge.sourceId === parentOwner &&
              edge.targetId === parentId,
          )
        )
          throw new Error(
            'Selected recovery has a missing or foreign Growth context',
          );
      }
    }
    const fingerprints = new Set<string>();
    const verifiedRoots = new Set<string>();
    const manifest = new FileManifest(store);
    for (const head of contentHeads) {
      if (
        head.formatVersion !== 1 ||
        !Number.isSafeInteger(head.revision) ||
        head.revision < 1 ||
        (nodes.get(head.cruxId)?.kind === 'snapshot' && head.revision !== 1)
      )
        throw new Error('Invalid selected content head');
      if (!verifiedRoots.has(head.root)) {
        for (const fp of await manifest.verify(head.root)) fingerprints.add(fp);
        verifiedRoots.add(head.root);
      }
    }
    for (const history of editHistory)
      for (const checkpoint of history.checkpoints) {
        if (!verifiedRoots.has(checkpoint.root)) {
          for (const fp of await manifest.verify(checkpoint.root))
            fingerprints.add(fp);
          verifiedRoots.add(checkpoint.root);
        }
      }
    for (const root of [
      ...resultRoots,
      ...workingCopies.map((copy) => copy.baseState.root),
    ])
      if (!verifiedRoots.has(root)) {
        for (const fp of await manifest.verify(root)) fingerprints.add(fp);
        verifiedRoots.add(root);
      }
    const assets = new Set<string>();
    const add = (value: unknown) => {
      if (value == null) return;
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new Error('Invalid selected content reference');
      assets.add(value);
    };
    // Typed references only: do not interpret arbitrary user JSON as blob IDs.
    for (const node of [...nodes.values(), ...workingCopies]) {
      const meta = object(node.meta);
      for (const author of Object.values(meta.authorSnapshots ?? {}))
        add(object(author).avatarFingerprint);
      for (const persona of Object.values(meta.personaSnapshots ?? {})) {
        add(object(persona).thumbnailFingerprint);
        add(object(persona).thumbnailFingerprintLight);
      }
    }
    for (const merge of taskMerges) {
      const data = object(
        typeof merge.data === 'string' ? JSON.parse(merge.data) : merge.data,
      );
      for (const key of ['base', 'main', 'task', 'manifest'])
        for (const entry of Object.values(data[key] ?? {}))
          add(object(entry).fingerprint);
      for (const conflict of Object.values(data.conflicts ?? {}))
        for (const key of ['base', 'main', 'task']) {
          const entry = object(conflict)[key];
          if (entry != null) add(object(entry).fingerprint);
        }
    }
    for (const fp of assets) {
      if (fingerprints.has(fp)) continue;
      const bytes = await store.read(fp);
      if (
        !(bytes instanceof Uint8Array) ||
        createHash('sha256').update(bytes).digest('hex') !== fp
      )
        throw new Error(`Selected content is missing or corrupt: ${fp}`);
      fingerprints.add(fp);
    }
    return JSON.parse(
      JSON.stringify({
        selection,
        cruxes: sorted([...nodes.values()]),
        dimensions,
        workingCopies,
        taskMerges,
        store: unwrap(await this.repository.rows('store', [...selected])),
        contentHeads,
        editHistory,
        boundary,
        fingerprints: [...fingerprints].sort(),
      }),
    );
  }
}
