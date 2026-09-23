import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CruxGraphService } from '../crux/crux-graph.service';
import { WorkingCopyRepository } from './working-copy.repository';
import {
  LocalWorkingCopyCreate,
  PrepareWorkingCopyFolder,
} from './working-copy-create';

/** Called inside the API owner's transaction with captured, validated input.
 * Content preparation, transient workspace admission and merge policy stay separate. */
@Injectable()
export class WorkingCopyService {
  constructor(
    private readonly copies: WorkingCopyRepository,
    private readonly crux: CruxGraphService,
  ) {}

  private async setupState(id: string, revision: number) {
    const result = await this.copies.find(id);
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    const copy = result.data;
    if (!copy) throw new NotFoundException('Working Copy not found.');
    await this.crux.findById(copy.crux_id);
    if (
      !['task', 'review'].includes(copy.role) ||
      !['preparing', 'failed'].includes(copy.phase) ||
      copy.revision !== revision
    )
      throw new ConflictException(
        'This Task no longer has the setup state you started with. Reopen it before retrying.',
      );
    const pending = await this.copies.hasApplyingMerge(id);
    if (pending.error)
      throw new InternalServerErrorException(pending.error.message);
    if (pending.data.pending)
      throw new ConflictException(
        'Recover the pending merge before changing Task setup.',
      );
    return copy;
  }

  async prepareFolder(
    id: string,
    revision: number,
    prepare: PrepareWorkingCopyFolder,
  ) {
    const copy = await this.setupState(id, revision);
    const folder = await prepare(id, copy.project_folder);
    if (typeof folder !== 'string' || !folder.trim())
      throw new Error('Task Project Folder preparation failed');
    const saved = await this.copies.setSetup(copy, 'preparing', folder);
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return { folder, cruxId: copy.crux_id };
  }

  async finishSetup(id: string, revision: number, phase: 'ready' | 'failed') {
    const copy = await this.setupState(id, revision);
    if (
      phase === 'ready' &&
      (copy.phase !== 'preparing' || !copy.project_folder)
    )
      throw new ConflictException(
        'Prepare the Task folder before completing setup.',
      );
    const saved = await this.copies.setSetup(copy, phase, copy.project_folder);
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return copy.crux_id;
  }

  async create(input: LocalWorkingCopyCreate): Promise<void> {
    const parent = await this.crux.findById(input.cruxId);
    if ((parent.kind as string) === 'snapshot')
      throw new ConflictException('Start new Tasks from Main, not a snapshot.');
    const inspected = await this.copies.creationContext(input);
    if (inspected.error)
      throw new InternalServerErrorException(inspected.error.message);
    const { collision, base, linked, pending } = inspected.data!;
    if (collision)
      throw new ConflictException('This Task identity already exists.');
    if (
      !base ||
      !linked ||
      (base.meta?.contentOwnerId !== undefined &&
        base.meta.contentOwnerId !== input.cruxId)
    )
      throw new ConflictException(
        'The Task base must belong to Main’s preserved Growth.',
      );
    if (pending)
      throw new ConflictException(
        'Finish recovering Main’s merge before starting a Task.',
      );
    const saved = await this.copies.create(input);
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
  }

  async setArchived(
    id: string,
    archived: boolean,
    revision: number,
  ): Promise<string> {
    const result = await this.copies.find(id);
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    const copy = result.data;
    if (!copy) throw new NotFoundException('Working Copy not found.');
    await this.crux.findById(copy.crux_id);
    if (copy.role !== 'task' || !['ready', 'archived'].includes(copy.phase))
      throw new ConflictException(
        'Only ready or archived tasks can be archived or reopened.',
      );
    if (copy.revision !== revision)
      throw new ConflictException(
        'This task changed while saving. Reload it before retrying.',
      );
    const pending = await this.copies.hasApplyingMerge(id);
    if (pending.error)
      throw new InternalServerErrorException(pending.error.message);
    if (pending.data.pending)
      throw new ConflictException(
        'Finish recovering the pending merge before archiving or reopening this Task.',
      );
    const saved = await this.copies.setArchived(
      id,
      revision,
      archived ? 'archived' : 'ready',
    );
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return copy.crux_id;
  }

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
