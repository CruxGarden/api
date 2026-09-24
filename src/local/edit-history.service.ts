import { EditRetentionService } from './edit-retention.service';
import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  FileContentService,
  FileContentSelection,
  captureFileContentSelection,
} from './file-content.service';
import { FileContentRepository } from './file-content.repository';
import { EditHistoryRepository } from './edit-history.repository';
import { EditCheckpoint } from './edit-history';
import { DesktopContentStore } from './desktop-content';
import { FileManifest } from './file-manifest';
import { RepositoryResponse } from '../common/types/interfaces';

export interface EditCheckpointCapture extends FileContentSelection {
  reason?: EditCheckpoint['reason'];
}
export function captureEditCheckpoint(
  input: EditCheckpointCapture,
): EditCheckpointCapture {
  const selected = captureFileContentSelection(input);
  if (
    input.reason !== undefined &&
    input.reason !== 'autosave' &&
    input.reason !== 'safety'
  )
    throw new Error('Choose automatic recovery or a protected safety copy');
  return { ...selected, reason: input.reason ?? 'autosave' };
}

export interface EditCheckpointRestore extends FileContentSelection {
  checkpointId: string;
}
export function captureEditCheckpointRestore(
  input: EditCheckpointRestore,
): EditCheckpointRestore {
  const selected = captureFileContentSelection(input);
  if (!isUUID(input.checkpointId))
    throw new Error('Select a retained edit checkpoint');
  return { ...selected, checkpointId: input.checkpointId };
}
const unwrap = <T>(result: RepositoryResponse<T>): T => {
  if (result.error)
    throw new InternalServerErrorException(result.error.message);
  return result.data!;
};

/** Internal content recovery, deliberately outside the Crux/Dimension graph. */
@Injectable()
export class EditHistoryService {
  constructor(
    private readonly history: EditHistoryRepository,
    private readonly content: FileContentService,
    private readonly files: FileContentRepository,
    private readonly retention: EditRetentionService,
  ) {}
  async list(cruxId: string) {
    if (!isUUID(cruxId)) throw new Error('Use a content owner identity');
    await this.content.owner(cruxId);
    return (
      unwrap(await this.history.read(cruxId)) ?? {
        cruxId,
        revision: 0,
        checkpoints: [],
      }
    );
  }
  async capture(
    input: FileContentSelection,
    store: DesktopContentStore,
    reason: EditCheckpoint['reason'] = 'autosave',
  ) {
    const head = await this.content.admit(input);
    if (!head)
      throw new ConflictException('Edit history requires committed content');
    await new FileManifest(store).verify(head.root);
    return this.retention.record(input.cruxId, head.root, reason);
  }

  async inspect(
    cruxId: string,
    checkpointId: string,
    store: DesktopContentStore,
  ) {
    const retained = await this.list(cruxId);
    const checkpoint = retained.checkpoints.find(
      (item) => item.id === checkpointId,
    );
    if (!checkpoint)
      throw new ConflictException('This edit checkpoint is no longer retained');
    return {
      checkpoint,
      files: await new FileManifest(store).entries(checkpoint.root),
    };
  }
  async restore(input: EditCheckpointRestore, store: DesktopContentStore) {
    await this.content.admit(input);
    const retained = await this.list(input.cruxId);
    const checkpoint = retained.checkpoints.find(
      (item) => item.id === input.checkpointId,
    );
    if (!checkpoint)
      throw new ConflictException('This edit checkpoint is no longer retained');
    await new FileManifest(store).verify(checkpoint.root);
    const safety = await this.capture(input, store, 'safety');
    const head = await this.content.commit(
      { cruxId: input.cruxId, expected: input.expected, root: checkpoint.root },
      store,
    );
    await this.files.queueProjection(input.cruxId, head);
    return { head, safety };
  }
}
