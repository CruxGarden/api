import { captureCruxUpdate } from './crux-update';

/** A prepared Task/review identity; folder and content setup follow separately. */
export interface LocalWorkingCopyCreate {
  id: string;
  cruxId: string;
  taskId: string;
  title: string;
  baseSnapshotId: string;
  role: 'task' | 'review';
  meta: Record<string, unknown>;
}
export function captureWorkingCopyCreate(
  input: LocalWorkingCopyCreate,
): LocalWorkingCopyCreate {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use a Task creation object');
  const fields = [
    'id',
    'cruxId',
    'taskId',
    'title',
    'baseSnapshotId',
    'role',
    'meta',
  ];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new Error('Unsupported Task creation field');
  for (const key of [
    'id',
    'cruxId',
    'taskId',
    'title',
    'baseSnapshotId',
  ] as const)
    if (typeof input[key] !== 'string' || !input[key].trim())
      throw new Error(`Use a Task ${key}`);
  if (!['task', 'review'].includes(input.role))
    throw new Error('Use a Task or review role');
  if (
    !input.meta ||
    typeof input.meta !== 'object' ||
    Array.isArray(input.meta)
  )
    throw new Error('Use Task metadata');
  const meta = captureCruxUpdate({ meta: input.meta }).meta!;
  delete meta.projectFolder;
  delete meta.workingCopy;
  return { ...input, title: input.title.trim(), meta };
}
