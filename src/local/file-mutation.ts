import { FileEntry, captureFileEdits } from './file-manifest';
import {
  FileContentCommit,
  FileContentSelection,
  captureFileContentEdit,
  captureFileContentSelection,
} from './file-content.service';
import type { FileRenameIntent } from './file-rename';

export interface FileContentWrite {
  cruxId: string;
  expected: FileContentCommit['expected'];
  /** Required exact approved destination, or explicit absence. */
  before: FileEntry | null;
  /** Explicit destructive replacement; ordinary saves use bounded autosave history. */
  retention?: 'safety';
  entry: FileEntry;
  bytes: Uint8Array;
}
export interface FileContentDelete extends FileContentSelection {
  file: FileEntry;
}
export interface FileWriteIntent {
  kind: 'write';
  operationId: string;
  before: FileEntry | null;
  entry: FileEntry;
}
export interface FileDeleteIntent {
  kind: 'delete';
  operationId: string;
  source: FileEntry;
}
export type FileProjectionIntent =
  | FileRenameIntent
  | FileWriteIntent
  | FileDeleteIntent;
/** The API supplies verified write bytes only during projection, never renderer callbacks. */
export type FileProjectionHost = (
  folder: string,
  intent: FileProjectionIntent,
  apply: boolean,
  bytes?: Uint8Array,
) => void | Promise<void>;
const captureEntry = (entry: FileEntry) =>
  (captureFileEdits([{ put: entry }])[0] as { put: FileEntry }).put;
export function captureFileWrite(input: FileContentWrite): FileContentWrite {
  if (!input || !(input.bytes instanceof Uint8Array))
    throw new Error('Use declared file bytes');
  if (input.retention !== undefined && input.retention !== 'safety')
    throw new Error('Use supported write retention');
  const captured = captureFileContentEdit({
    cruxId: input.cruxId,
    expected: input.expected,
    changes: [{ put: input.entry, bytes: input.bytes }],
  });
  const before = input.before === null ? null : captureEntry(input.before);
  const entry = (captured.edits[0] as { put: FileEntry }).put;
  if (before && (before.path !== entry.path || before.id !== entry.id))
    throw new Error(
      'Writing must preserve the approved file identity and path',
    );
  return {
    cruxId: captured.cruxId,
    expected: captured.expected,
    before,
    ...(input.retention === 'safety' ? { retention: 'safety' as const } : {}),
    entry,
    bytes: captured.files[0].bytes,
  };
}
export function captureFileDelete(input: FileContentDelete): FileContentDelete {
  return {
    ...captureFileContentSelection(input),
    file: captureEntry(input.file),
  };
}
