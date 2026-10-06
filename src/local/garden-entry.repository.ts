import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';

export const LOCAL_GARDEN_ID = 'cruxgarden:local:rootGardenId';
export const LOCAL_AUTHOR_ID = 'cruxgarden:local:authorId';
export const LOCAL_HOME_ID = 'cruxgarden:local:homeId';

/** Installation discovery references, not portable graph membership. */
@Injectable()
export class GardenEntryRepository {
  constructor(private readonly db: DbService) {}

  async read() {
    try {
      const rows = await this.db
        .query()('settings')
        .whereIn('key', [LOCAL_GARDEN_ID, LOCAL_AUTHOR_ID, LOCAL_HOME_ID])
        .select('key', 'value');
      return success(
        Object.fromEntries(rows.map((row) => [row.key, row.value])) as Record<
          string,
          string
        >,
      );
    } catch (error) {
      return failure<Record<string, string>>(error);
    }
  }

  async insert(values: Record<string, string>) {
    try {
      await this.db
        .query()('settings')
        .insert(Object.entries(values).map(([key, value]) => ({ key, value })));
      const stored = await this.read();
      if (stored.error) throw stored.error;
      if (
        Object.entries(values).some(
          ([key, value]) => stored.data?.[key] !== value,
        )
      )
        throw new Error('The local Garden entry was not saved');
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }
}
