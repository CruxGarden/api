import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'util';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';
import { parseEditHistory, EditHistory } from './edit-history';

@Injectable()
export class EditHistoryRepository {
  constructor(private readonly db: DbService) {}
  async read(cruxId: string) {
    try {
      const row = await this.db
        .query()('edit_history')
        .where({ crux_id: cruxId })
        .first();
      return success<EditHistory | null>(
        row
          ? parseEditHistory({
              cruxId,
              revision: row.revision,
              checkpoints:
                typeof row.checkpoints === 'string'
                  ? JSON.parse(row.checkpoints)
                  : row.checkpoints,
            })
          : null,
      );
    } catch (error) {
      return failure<EditHistory | null>(error);
    }
  }
  async write(value: EditHistory, previous: EditHistory | null) {
    try {
      const saved = parseEditHistory(value);
      const row = {
        crux_id: saved.cruxId,
        revision: saved.revision,
        checkpoints: JSON.stringify(saved.checkpoints),
      };
      if (previous) {
        if (
          (await this.db
            .query()('edit_history')
            .where({ crux_id: saved.cruxId, revision: previous.revision })
            .update(row)) !== 1
        )
          throw new Error('Edit history changed before capture');
      } else await this.db.query()('edit_history').insert(row);
      const result = await this.read(saved.cruxId);
      if (result.error || !isDeepStrictEqual(result.data, saved))
        throw new Error('Edit history did not persist');
      return success(saved);
    } catch (error) {
      return failure<EditHistory>(error);
    }
  }
}
