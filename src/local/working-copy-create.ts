import { captureCruxUpdate } from './crux-update';
import {
  captureFileContentSelection,
  FileContentSelection,
} from './file-content.service';

/** A prepared Task/review identity; folder and content setup follow separately. */
export interface LocalWorkingCopyCreate {
  id: string;
  cruxId: string;
  taskId: string;
  title: string;
  base: {
    expected: FileContentSelection['expected'];
    expectedMeta: Record<string, unknown>;
  };
  role: 'task' | 'review';
  meta: Record<string, unknown>;
}
export function captureWorkingCopyCreate(
  input: LocalWorkingCopyCreate,
): LocalWorkingCopyCreate {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use a Task creation object');
  const fields = ['id', 'cruxId', 'taskId', 'title', 'base', 'role', 'meta'];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new Error('Unsupported Task creation field');
  for (const key of ['id', 'cruxId', 'taskId', 'title'] as const)
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
  const expected = captureFileContentSelection({
    cruxId: input.cruxId,
    expected: input.base?.expected,
  }).expected;
  if (!expected || !input.base?.expectedMeta)
    throw new Error('Use the expected Main starting state');
  const expectedMeta = captureCruxUpdate({
    meta: input.base.expectedMeta,
  }).meta!;
  return {
    ...input,
    base: { expected, expectedMeta },
    title: input.title.trim(),
    meta,
  };
}

/** Trusted native hook only; it must not call the queued owner. Retain files after DB refusal. */
export type PrepareWorkingCopyFolder = (
  id: string,
  current: string | null,
) => string | Promise<string>;
