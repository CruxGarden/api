import { createHash } from 'crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { RepositoryResponse } from '../common/types/interfaces';
import { DesktopContentStore } from './desktop-content';
import {
  FileManifest,
  FileEntry,
  FileEdit,
  captureFileEdits,
} from './file-manifest';
import {
  FileContentHead,
  FileContentRepository,
} from './file-content.repository';

export interface FileContentCommit {
  cruxId: string;
  expected: { root: string; revision: number } | null;
  root: string;
}
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function captureFileContent(
  input: FileContentCommit,
): FileContentCommit {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use a file content commit');
  const { cruxId, root, expected } = input;
  if (
    typeof cruxId !== 'string' ||
    !cruxId ||
    !fingerprint(root) ||
    (expected !== null &&
      (!expected ||
        !fingerprint(expected.root) ||
        !Number.isSafeInteger(expected.revision) ||
        expected.revision < 1 ||
        expected.revision >= Number.MAX_SAFE_INTEGER))
  )
    throw new Error('Use a Crux identity, content root and expected revision');
  return {
    cruxId,
    root,
    expected:
      expected === null
        ? null
        : { root: expected.root, revision: expected.revision },
  };
}

export interface FileContentSelection {
  cruxId: string;
  expected: { root: string; revision: number };
}
export interface FileContentRead extends FileContentSelection {
  path: string;
}
export interface FileContentListResult {
  head: FileContentHead;
  entries: FileEntry[];
}
export interface FileContentReadResult {
  head: FileContentHead;
  entry: FileEntry;
  bytes: Uint8Array;
}
export function captureFileContentSelection(
  input: FileContentSelection,
): FileContentSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use a version-bound content selection');
  const { cruxId, expected } = input;
  if (
    typeof cruxId !== 'string' ||
    !cruxId ||
    !expected ||
    !fingerprint(expected.root) ||
    !Number.isSafeInteger(expected.revision) ||
    expected.revision < 1
  )
    throw new Error('Use a version-bound content selection');
  return {
    cruxId,
    expected: { root: expected.root, revision: expected.revision },
  };
}
export function captureFileContentRead(
  input: FileContentRead,
): FileContentRead {
  const selected = captureFileContentSelection(input);
  if (typeof input.path !== 'string' || !input.path)
    throw new Error('Use a version-bound file reference');
  return { ...selected, path: input.path };
}

export type FileContentChange =
  | { put: FileEntry; bytes?: Uint8Array }
  | { remove: string };
export interface FileContentEdit {
  cruxId: string;
  expected: FileContentCommit['expected'];
  changes: FileContentChange[];
}
export interface CapturedFileContentEdit {
  cruxId: string;
  expected: FileContentCommit['expected'];
  edits: FileEdit[];
  files: { fingerprint: string; bytes: Uint8Array }[];
}
export function captureFileContentEdit(
  input: FileContentEdit,
): CapturedFileContentEdit {
  if (!input || typeof input !== 'object' || !Array.isArray(input.changes))
    throw new Error('Use a file edit batch');
  const { cruxId, expected } = input;
  if (
    typeof cruxId !== 'string' ||
    !cruxId ||
    (expected !== null &&
      (!expected ||
        !fingerprint(expected.root) ||
        !Number.isSafeInteger(expected.revision) ||
        expected.revision < 1 ||
        expected.revision >= Number.MAX_SAFE_INTEGER))
  )
    throw new Error('Use a Crux identity and expected content revision');
  const edits = captureFileEdits(
    input.changes.map((change) => {
      if (!change || typeof change !== 'object')
        throw new Error('Invalid file change');
      if ('put' in change) {
        if (Object.keys(change).some((key) => key !== 'put' && key !== 'bytes'))
          throw new Error('Invalid file change fields');
        return { put: change.put };
      }
      return change;
    }),
  );
  const files: CapturedFileContentEdit['files'] = [];
  input.changes.forEach((change, index) => {
    if ('put' in change && change.bytes !== undefined) {
      const entry = (edits[index] as { put: FileEntry }).put;
      if (!(change.bytes instanceof Uint8Array))
        throw new Error('Use file bytes');
      const bytes = Uint8Array.from(change.bytes);
      if (
        bytes.length !== entry.size ||
        createHash('sha256').update(bytes).digest('hex') !== entry.fingerprint
      )
        throw new Error('File bytes do not match the declared content');
      files.push({ fingerprint: entry.fingerprint, bytes });
    }
  });
  return {
    cruxId,
    expected:
      expected === null
        ? null
        : { root: expected.root, revision: expected.revision },
    edits,
    files,
  };
}

/** Called only inside the local API owner's transaction. No renderer/remote transport yet. */
@Injectable()
export class FileContentService {
  constructor(private readonly repository: FileContentRepository) {}
  private unwrap<T>(result: RepositoryResponse<T>): T {
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    return result.data!;
  }
  async head(id: string): Promise<FileContentHead | null> {
    const context = this.unwrap(await this.repository.context(id));
    if (!context.crux) throw new ConflictException('Crux not found');
    return context.head;
  }
  private async selectedHead(
    input: FileContentSelection,
  ): Promise<FileContentHead> {
    const head = await this.head(input.cruxId);
    if (
      !head ||
      head.formatVersion !== 1 ||
      head.root !== input.expected.root ||
      head.revision !== input.expected.revision
    )
      throw new ConflictException(
        'File content changed; reload before reading',
      );
    return head;
  }
  /** Initial file-tree projection, not an individual file lookup. Reads metadata only. */
  async list(
    input: FileContentSelection,
    store: DesktopContentStore,
  ): Promise<FileContentListResult> {
    const head = await this.selectedHead(input);
    return { head, entries: await new FileManifest(store).entries(head.root) };
  }
  async read(
    input: FileContentRead,
    store: DesktopContentStore,
  ): Promise<FileContentReadResult | null> {
    const head = await this.selectedHead(input);
    const file = await new FileManifest(store).readFile(head.root, input.path);
    return file ? { head, ...file } : null;
  }
  /** Admission shared by file edits and snapshot capture inside the owner transaction. */
  async admit(
    input: Pick<FileContentCommit, 'cruxId' | 'expected'>,
  ): Promise<FileContentHead | null> {
    const context = this.unwrap(await this.repository.context(input.cruxId));
    if (
      !context.crux ||
      context.crux.deleted !== null ||
      context.crux.kind === 'snapshot'
    )
      throw new ConflictException('File content requires a live editable Crux');
    if (context.legacy || context.task || context.review || context.history)
      throw new ConflictException(
        'This Crux is not supported by the new content writer yet',
      );
    const before = context.head as FileContentHead | null;
    if (
      before &&
      (before.formatVersion !== 1 ||
        !fingerprint(before.root) ||
        !Number.isSafeInteger(before.revision) ||
        before.revision < 1 ||
        before.revision >= Number.MAX_SAFE_INTEGER)
    )
      throw new ConflictException('Invalid stored file content head');
    if (
      (before === null) !== (input.expected === null) ||
      (before &&
        (before.root !== input.expected!.root ||
          before.revision !== input.expected!.revision))
    )
      throw new ConflictException('File content changed; reload before saving');
    return before;
  }
  async commit(
    input: FileContentCommit,
    store: DesktopContentStore,
  ): Promise<FileContentHead> {
    const before = await this.admit(input);
    await new FileManifest(store).verify(input.root);
    return this.publish(input, before);
  }
  async edit(
    input: CapturedFileContentEdit,
    store: DesktopContentStore,
  ): Promise<FileContentHead> {
    const before = await this.admit(input);
    for (const file of input.files) {
      const existing = await store.read(file.fingerprint);
      if (existing === null) await store.write(file.fingerprint, file.bytes);
      else if (
        !(existing instanceof Uint8Array) ||
        createHash('sha256').update(existing).digest('hex') !== file.fingerprint
      )
        throw new Error('Existing file content failed integrity check');
    }
    const tree = new FileManifest(store);
    // apply verifies every introduced payload, traversed node and newly staged
    // node. Unchanged subtrees already belong to the admitted immutable head;
    // rescanning them here turns a one-file save into a whole-project read.
    // Arbitrary root commits, snapshots, restore and recovery still verify
    // complete trees; ordinary reads verify the selected file on access.
    const root = await tree.apply(before?.root ?? null, input.edits);
    return this.publish(
      { cruxId: input.cruxId, expected: input.expected, root },
      before,
    );
  }
  private async publish(
    input: FileContentCommit,
    before: FileContentHead | null,
  ): Promise<FileContentHead> {
    if (before?.root === input.root) return before;
    return this.unwrap(
      await this.repository.publish(
        {
          cruxId: input.cruxId,
          formatVersion: 1,
          root: input.root,
          revision: (before?.revision ?? 0) + 1,
        },
        before,
      ),
    );
  }
}
