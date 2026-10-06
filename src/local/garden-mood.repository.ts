import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';
import DimensionRaw from '../dimension/entities/dimension-raw.entity';

export const MOOD_ASSOCIATION = 'mood';

@Injectable()
export class GardenMoodRepository {
  constructor(private readonly db: DbService) {}
  private links(gardenId: string) {
    return this.db
      .query()('dimensions')
      .where({ source_id: gardenId, type: 'graft', kind: MOOD_ASSOCIATION })
      .whereNull('deleted');
  }
  async list(gardenId: string) {
    try {
      return success<DimensionRaw[]>(await this.links(gardenId).orderBy('id'));
    } catch (error) {
      return failure<DimensionRaw[]>(error);
    }
  }
  async clear(gardenId: string) {
    try {
      return success(
        await this.links(gardenId).update({ deleted: new Date() }),
      );
    } catch (error) {
      return failure<number>(error);
    }
  }
}
