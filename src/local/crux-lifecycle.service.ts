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
  constructor(private readonly repository: CruxLifecycleRepository) {}
  private unwrap<T>(result: RepositoryResponse<T>): T {
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    return result.data!;
  }
  async setTrashed(id: string, trashed: boolean): Promise<void> {
    const state = this.unwrap(await this.repository.inspect(id));
    if (state.copy)
      throw new ConflictException(
        'This action belongs to Main. Open Main to continue.',
      );
    if (state.crux) this.unwrap(await this.repository.setTrashed(id, trashed));
  }
  async purge(id: string): Promise<void> {
    const state = this.unwrap(await this.repository.inspect(id));
    if (state.copy)
      throw new ConflictException(
        'This action belongs to Main. Open Main to continue.',
      );
    if (!state.crux) return; // An already removed identity is an idempotent no-op.
    const refs = this.unwrap(await this.repository.references(id));
    if (refs.history)
      throw new ConflictException('This snapshot is used by a task or merge.');
    if (refs.shared)
      throw new ConflictException(
        'This snapshot is shared or referenced by other work.',
      );
    const { ids } = this.unwrap(await this.repository.plan(id));
    this.unwrap(await this.repository.purge(id, ids));
  }
}
