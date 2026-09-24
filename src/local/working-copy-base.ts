import { z } from 'zod';
import type { RetainedWorkspaceState } from './workspace-state.service';
import { retainedWorkspaceSchema } from './edit-history';

/** No source means Main; otherwise this is the exact operational parent. */
export const workingCopyBaseSchema = retainedWorkspaceSchema.extend({
  sourceId: z.string().uuid().optional(),
});
export interface WorkingCopyBase extends RetainedWorkspaceState {
  sourceId?: string;
}
export interface CopySource {
  id: string;
  cruxId: string;
  role: string;
  baseState: WorkingCopyBase;
}

/** Validate even unmarked source chains: absence of Growth must not hide a cycle. */
export function copySourceChain(
  id: string,
  copies: ReadonlyMap<string, CopySource>,
): CopySource[] {
  const chain: CopySource[] = [];
  const seen = new Set<string>();
  let copy = copies.get(id);
  while (copy) {
    if (seen.has(copy.id))
      throw new Error('Working Copy sources contain a cycle');
    seen.add(copy.id);
    chain.push(copy);
    const source = copy.baseState.sourceId;
    if (!source || source === copy.cruxId) break;
    const parent = copies.get(source);
    if (!parent || parent.cruxId !== copy.cruxId || parent.role !== 'task')
      throw new Error(
        'Working Copy source is missing or belongs to another Crux',
      );
    copy = parent;
  }
  return chain;
}

/** A marked ancestor may cross each source boundary only at its retained anchor. */
export function copyParentOwner(
  id: string,
  parentId: string,
  copies: ReadonlyMap<string, CopySource>,
): string {
  let owner = id;
  for (const copy of copySourceChain(id, copies)) {
    if (copy.baseState.workspace.parentId !== parentId) break;
    owner = copy.baseState.sourceId ?? copy.cruxId;
  }
  return owner;
}

/** Runtime reads only the requested chain; archives already have their captured map. */
export async function readCopySources(
  id: string,
  find: (
    id: string,
  ) => Promise<
    | { id: string; crux_id: string; role: string; base_state: string }
    | undefined
  >,
): Promise<ReadonlyMap<string, CopySource>> {
  const sources = new Map<string, CopySource>();
  let next: string | undefined = id;
  while (next && !sources.has(next)) {
    const row = await find(next);
    if (!row) break;
    const copy = {
      id: row.id,
      cruxId: row.crux_id,
      role: row.role,
      baseState: workingCopyBaseSchema.parse(
        JSON.parse(row.base_state),
      ) as WorkingCopyBase,
    };
    sources.set(copy.id, copy);
    next = copy.baseState.sourceId;
    if (next === copy.cruxId) break;
  }
  copySourceChain(id, sources);
  return sources;
}
