/** Selection is graph policy; existing meta.mood is opaque content. */
export type GardenMoodMode = 'inherit' | 'own' | 'none';
export function gardenMoodMode(value: unknown): GardenMoodMode {
  if (value === undefined) return 'inherit';
  const policy = value as { version?: number; mode?: unknown };
  if (
    !policy ||
    policy.version !== 1 ||
    !['inherit', 'own', 'none'].includes(policy.mode as string)
  )
    throw new Error('This Garden’s Mood policy is unsupported');
  return policy.mode as GardenMoodMode;
}
interface Node {
  id?: string;
  kind?: string | null;
  deleted?: unknown;
  meta?: Record<string, unknown>;
}
interface Edge {
  id?: string;
  sourceId?: string | null;
  targetId?: string | null;
  type?: string;
  kind?: string | null;
}
/** Shared admission contract for private graphs and detached database recovery. */
export function assertGardenMoodAssociations(
  nodes: Node[],
  edges: Edge[],
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Map<string, Edge[]>();
  for (const edge of edges)
    if (edge.type === 'graft' && edge.kind === 'mood' && edge.sourceId) {
      const list = selected.get(edge.sourceId) ?? [];
      list.push(edge);
      selected.set(edge.sourceId, list);
    }
  for (const node of nodes) {
    if (node.kind !== 'garden') continue;
    const mode = gardenMoodMode(node.meta?.moodSelection);
    const links = selected.get(node.id) ?? [];
    if (links.length !== (mode === 'own' ? 1 : 0))
      throw new Error('This Garden’s Mood association is inconsistent');
    if (mode === 'own') {
      const target = byId.get(links[0].targetId!);
      if (!target || target.kind !== 'mood' || target.deleted)
        throw new Error('The Garden’s selected Mood is unavailable');
    }
  }
}
