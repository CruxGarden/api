import { editHistorySchema } from './edit-history';
import { z } from 'zod';
import { isDeepStrictEqual } from 'util';
import type { SelectedGraphCapture } from './selected-graph.service';

const id = z.string().uuid();
const text = z.string();
const nullableText = text.nullable();
const date = z.string().datetime({ offset: true });
const meta = z.record(z.unknown());
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const identity = { id, created: date, updated: date };
const dimensionType = z.enum(['gate', 'garden', 'growth', 'graft']);
const boundary = z
  .object({
    id,
    sourceId: id,
    targetId: id,
    type: dimensionType,
    kind: nullableText,
    state: z.enum(['outside-selection', 'unavailable']),
  })
  .strict();

/** Private backup only. Graph and immutable file payload have independent versions.
 * Column allowlists prevent importing SQL/install fields hidden in untrusted rows. */
export const privateGraphSchema = z
  .object({
    purpose: z.literal('private-backup'),
    graphVersion: z.literal(1),
    payloadVersion: z.literal(1),
    selection: z
      .object({ roots: z.array(id).min(1), includeMembers: z.boolean() })
      .strict(),
    cruxes: z.array(
      z
        .object({
          ...identity,
          slug: nullableText,
          title: text,
          description: text,
          data: text,
          type: text,
          kind: nullableText,
          status: text,
          authorId: id,
          homeId: id,
          meta,
        })
        .strict(),
    ),
    dimensions: z.array(
      z
        .object({
          ...identity,
          sourceId: id,
          targetId: id,
          type: dimensionType,
          kind: nullableText,
          weight: z.number().finite().nullable(),
          authorId: id.nullable(),
          homeId: id,
          note: nullableText,
          meta,
        })
        .strict(),
    ),
    workingCopies: z.array(
      z
        .object({
          ...identity,
          cruxId: id,
          taskId: id,
          title: text,
          baseSnapshotId: id,
          role: z.enum(['task', 'review']),
          phase: z.enum(['preparing', 'ready', 'merged', 'archived', 'failed']),
          meta,
        })
        .strict(),
    ),
    taskMerges: z.array(
      z
        .object({
          id,
          cruxId: id,
          copyId: id,
          candidateId: id,
          phase: z.enum(['review', 'merged', 'cancelled']),
          data: meta,
          created: date,
        })
        .strict(),
    ),
    store: z.array(
      z
        .object({
          ...identity,
          cruxId: id,
          visitorId: nullableText,
          key: text,
          value: text,
          mode: z.enum(['protected', 'public']),
        })
        .strict(),
    ),
    contentHeads: z.array(
      z
        .object({
          cruxId: id,
          formatVersion: z.literal(1),
          root: fingerprint,
          revision: z.number().int().positive().safe(),
        })
        .strict(),
    ),
    editHistory: z.array(editHistorySchema).optional(),
    boundary: z.array(boundary),
    fingerprints: z.array(fingerprint),
  })
  .strict();
export type PrivateGraph = z.infer<typeof privateGraphSchema>;
export type GraphBoundary = PrivateGraph['boundary'];

export const graphImportSchema = z
  .object({
    requestId: id,
    mode: z.enum(['copy', 'restore', 'replace']),
    replacementToken: fingerprint.optional(),
    gardenId: id.optional(),
    destination: z.object({ authorId: id, homeId: id }).strict(),
    graph: privateGraphSchema,
  })
  .strict();
export type PrivateGraphImport = z.infer<typeof graphImportSchema>;
export interface PrivateGraphImportResult {
  roots: string[];
  ids: Record<string, string>;
  boundary: GraphBoundary;
  safetyArchive?: string;
}

/** Removes only application-owned execution/installation fields. Opaque private
 * user content is preserved; this must never be used as a public projection. */
export function portableGraphMeta(raw: Record<string, any>) {
  const result = JSON.parse(JSON.stringify(raw));
  for (const key of [
    'projectFolder',
    'publishedAt',
    'publishedVersion',
    'publishedFingerprints',
    'turnJob',
    'turnQueue',
    'agentHost',
  ])
    delete result[key];
  if (result.settings && typeof result.settings === 'object')
    for (const key of [
      'agentSessionId',
      'agentSessions',
      'agentHost',
      'previewPort',
    ])
      delete result.settings[key];
  return result;
}
export function portableReview(raw: Record<string, any>) {
  const result = JSON.parse(JSON.stringify(raw));
  delete result.previewUrl;
  delete result.verifiedKey;
  return result;
}
const pick = (row: Record<string, any>, keys: string) =>
  Object.fromEntries(keys.split(' ').map((key) => [key, row[key]]));

export function projectPrivateGraph(
  capture: SelectedGraphCapture,
): PrivateGraph {
  return privateGraphSchema.parse({
    purpose: 'private-backup',
    graphVersion: 1,
    payloadVersion: 1,
    selection: capture.selection,
    cruxes: capture.cruxes.map((row) => ({
      ...pick(
        row,
        'id slug title description data type kind status authorId homeId created updated',
      ),
      meta: portableGraphMeta(row.meta),
    })),
    dimensions: capture.dimensions.map((row) =>
      pick(
        row,
        'id sourceId targetId type kind weight authorId homeId note meta created updated',
      ),
    ),
    workingCopies: capture.workingCopies.map((row) => ({
      ...pick(
        row,
        'id cruxId taskId title baseSnapshotId role phase created updated',
      ),
      meta: portableGraphMeta(row.meta),
    })),
    taskMerges: capture.taskMerges.map((row) => ({
      ...pick(row, 'id cruxId copyId candidateId phase created'),
      data: portableReview(
        typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      ),
    })),
    store: capture.store,
    contentHeads: capture.contentHeads,
    ...(capture.editHistory.length ? { editHistory: capture.editHistory } : {}),
    boundary: capture.boundary,
    fingerprints: capture.fingerprints,
  });
}

/** Capture JSON before queueing and reject rather than silently stripping fields. */
export function capturePrivateGraphImport(input: PrivateGraphImport) {
  const result = graphImportSchema.parse(JSON.parse(JSON.stringify(input)));
  if ((result.mode === 'replace') !== !!result.replacementToken)
    throw new Error('Replacement requires an exact current graph token');
  for (const row of [...result.graph.cruxes, ...result.graph.workingCopies])
    if (!isDeepStrictEqual(row.meta, portableGraphMeta(row.meta)))
      throw new Error(
        'Private graph contains installation or active session metadata',
      );
  for (const row of result.graph.taskMerges)
    if (!isDeepStrictEqual(row.data, portableReview(row.data)))
      throw new Error(
        'Private graph contains active review verification or preview state',
      );
  return result;
}

/** Typed fields only: prose, Store values and opaque payloads are never searched. */
export function remapGraphMeta(
  raw: Record<string, any>,
  ids: Record<string, string>,
) {
  const result = portableGraphMeta(raw);
  const replace = (value: any, keys: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of keys)
      if (typeof value[key] === 'string' && ids[value[key]])
        value[key] = ids[value[key]];
  };
  replace(result, ['parentCruxId', 'contentOwnerId']);
  replace(result.settings, ['activeBranch']);
  replace(result.workingCopy, ['cruxId', 'taskId', 'baseSnapshotId']);
  replace(result.merge, [
    'id',
    'taskId',
    'copyId',
    'baseId',
    'sourceHead',
    'targetHead',
    'resultHead',
  ]);
  if (Array.isArray(result.messages))
    for (const message of result.messages) replace(message, ['taskMergeId']);
  return result;
}
