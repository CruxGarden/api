import {
  GardenEntryRepository,
  LOCAL_GARDEN_ID,
} from './garden-entry.repository';
import { randomUUID } from 'crypto';
import { CruxGraphService } from '../crux/crux-graph.service';
import { CreateCruxDto } from '../crux/dto/create-crux.dto';
import { LocalCruxCreate, PrepareCruxFolder } from './crux-create';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { CruxLifecycleRepository } from './crux-lifecycle.repository';
import { RepositoryResponse } from '../common/types/interfaces';

/** Named local lifecycle operations. The host still owns transient workspace admission. */
@Injectable()
export class CruxLifecycleService {
  constructor(
    private readonly repository: CruxLifecycleRepository,
    private readonly crux: CruxGraphService,
    private readonly entries: GardenEntryRepository,
  ) {}
  private unwrap<T>(result: RepositoryResponse<T>): T {
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    return result.data!;
  }
  async create(
    input: LocalCruxCreate,
    prepareFolder?: PrepareCruxFolder,
  ): Promise<string> {
    const id = input.id ?? randomUUID();
    const state = this.unwrap(await this.repository.inspect(id));
    if (state.copy || state.crux)
      throw new ConflictException('A Crux with this identity already exists');
    const { slug } = this.unwrap(await this.repository.freeSlug(input.slug));
    let meta = input.meta ?? {};
    if (
      prepareFolder &&
      input.type === 'workspace' &&
      input.kind !== 'snapshot' &&
      !meta.projectFolder
    ) {
      const folder = await prepareFolder(slug);
      if (typeof folder !== 'string' || !folder.trim())
        throw new Error('Project Folder preparation failed');
      meta = { ...meta, projectFolder: folder };
    }
    const created = await this.crux.create({
      ...input,
      id,
      slug,
      title: input.title ?? '',
      description: input.description ?? '',
      data: input.data ?? '',
      type: input.type || 'crux',
      meta,
    } as CreateCruxDto);
    if (created.id !== id) throw new Error('Crux creation did not persist');
    return id;
  }
  private async protectEntry(ids: string[]): Promise<void> {
    const settings = this.unwrap(await this.entries.read());
    if (ids.includes(settings[LOCAL_GARDEN_ID]))
      throw new ConflictException('The local Garden entry cannot be deleted');
  }
  private async assertUnreferenced(id: string): Promise<void> {
    const refs = this.unwrap(await this.repository.references(id));
    if (refs.mood)
      throw new ConflictException(
        'This Mood is selected by a Garden. Change that selection before deleting it.',
      );
    if (refs.history)
      throw new ConflictException(
        'This snapshot is used by a task, merge or recovery copy.',
      );
    if (refs.shared)
      throw new ConflictException(
        'This snapshot is shared or referenced by other work.',
      );
  }
  async setTrashed(id: string, trashed: boolean): Promise<void> {
    if (trashed) await this.protectEntry([id]);
    const state = this.unwrap(await this.repository.inspect(id));
    if (state.copy)
      throw new ConflictException(
        'This action belongs to Main. Open Main to continue.',
      );
    if (trashed) await this.assertUnreferenced(id);
    if (state.crux) this.unwrap(await this.repository.setTrashed(id, trashed));
  }
  async purge(id: string): Promise<void> {
    const state = this.unwrap(await this.repository.inspect(id));
    if (state.copy)
      throw new ConflictException(
        'This action belongs to Main. Open Main to continue.',
      );
    if (!state.crux) return; // An already removed identity is an idempotent no-op.
    await this.assertUnreferenced(id);
    const { ids } = this.unwrap(await this.repository.plan(id));
    await this.protectEntry(ids);
    this.unwrap(await this.repository.purge(id, ids));
  }
}
