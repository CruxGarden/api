import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EditHistoryRepository } from './edit-history.repository';
import { EditCheckpoint, EDIT_HISTORY_LIMIT } from './edit-history';
import { RepositoryResponse } from '../common/types/interfaces';
const unwrap = <T>(result: RepositoryResponse<T>): T => {
  if (result.error)
    throw new InternalServerErrorException(result.error.message);
  return result.data!;
};

/** Retains already-admitted immutable roots in the owner's current transaction. */
@Injectable()
export class EditRetentionService {
  constructor(private readonly history: EditHistoryRepository) {}
  async record(
    cruxId: string,
    root: string,
    reason: EditCheckpoint['reason'],
    coalesce = false,
  ) {
    const previous = unwrap(await this.history.read(cruxId));
    const matches =
      previous?.checkpoints.filter((item) => item.reason === reason) ?? [];
    const latest = matches[matches.length - 1];
    if (latest?.root === root) return latest;
    const now = Date.now();
    if (coalesce && latest && now - Date.parse(latest.created) < 60_000)
      return latest;
    const checkpoint: EditCheckpoint = {
      id: randomUUID(),
      root,
      created: new Date(now).toISOString(),
      reason,
    };
    let automatic = 0;
    const checkpoints = [...(previous?.checkpoints ?? []), checkpoint]
      .reverse()
      .filter(
        (item) => item.reason === 'safety' || ++automatic <= EDIT_HISTORY_LIMIT,
      )
      .reverse();
    unwrap(
      await this.history.write(
        { cruxId, revision: (previous?.revision ?? 0) + 1, checkpoints },
        previous,
      ),
    );
    return checkpoint;
  }
}
