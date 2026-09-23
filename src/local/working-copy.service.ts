import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CruxGraphService } from '../crux/crux-graph.service';
import { WorkingCopyRepository } from './working-copy.repository';

/** Called inside the API owner's transaction with captured, validated input.
 * This edits descriptive state only; content/merge lifecycle policy stays separate. */
@Injectable()
export class WorkingCopyService {
  constructor(
    private readonly copies: WorkingCopyRepository,
    private readonly crux: CruxGraphService,
  ) {}

  async updateMeta(
    id: string,
    patch: Record<string, unknown>,
    title?: string,
  ): Promise<string> {
    const result = await this.copies.find(id);
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    if (!result.data) throw new NotFoundException('Working Copy not found.');
    const copy = result.data;
    await this.crux.findById(copy.crux_id);
    if (!copy.meta || typeof copy.meta !== 'object' || Array.isArray(copy.meta))
      throw new ConflictException(
        'This task has invalid metadata. Restore it before editing.',
      );
    if (
      !Number.isSafeInteger(copy.revision) ||
      copy.revision < 0 ||
      copy.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new ConflictException(
        'This task has an invalid revision. Restore it before editing.',
      );
    const meta = { ...copy.meta, ...patch };
    delete meta.workingCopy;
    delete meta.projectFolder;
    const saved = await this.copies.updateMeta(
      id,
      copy.revision,
      meta,
      title === undefined ? undefined : title.trim() || 'Untitled task',
    );
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    if (saved.data.changes !== 1)
      throw new ConflictException(
        'This task changed while saving. Reload it before retrying.',
      );
    return copy.crux_id;
  }
}
