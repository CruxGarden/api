import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { FileEntry, captureFileEdits } from './file-manifest';
import {
  FileContentSelection,
  captureFileContentSelection,
} from './file-content.service';

export interface FileRenameIntent {
  kind: 'rename';
  operationId: string;
  source: FileEntry;
  target: FileEntry | null;
  entry: FileEntry;
}
export interface FileContentRename extends FileContentSelection {
  source: FileEntry;
  target: FileEntry | null;
  entry: FileEntry;
}
export type FileRenameHost = (
  folder: string,
  intent: FileRenameIntent,
  apply: boolean,
) => void | Promise<void>;
export function captureFileRename(input: FileContentRename): FileContentRename {
  const selection = captureFileContentSelection(input);
  const capture = (entry: FileEntry) =>
    (captureFileEdits([{ put: entry }])[0] as { put: FileEntry }).put;
  const source = capture(input.source);
  const target = input.target === null ? null : capture(input.target);
  const entry = capture(input.entry);
  if (
    source.path === entry.path ||
    (target && target.path !== entry.path) ||
    !isDeepStrictEqual(
      {
        ...source,
        path: entry.path,
        attributes: entry.attributes,
        mimeType: entry.mimeType,
      },
      entry,
    )
  )
    throw new Error('Rename must preserve the source identity, bytes and mode');
  return { ...selection, source, target, entry };
}
export function renameIntent(input: FileContentRename): FileRenameIntent {
  return {
    kind: 'rename',
    operationId: randomUUID(),
    source: input.source,
    target: input.target,
    entry: input.entry,
  };
}
