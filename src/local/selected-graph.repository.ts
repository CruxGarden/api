import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';
import { toEntityFields } from '../common/helpers/case-helpers';

export type CapturedRecord = Record<string, any> & { id: string };

/** Source-side capture only. Never opens another database or reads unrelated settings. */
@Injectable()
export class SelectedGraphRepository {
  constructor(private readonly db: DbService) {}

  async targetAvailable(id: string) {
    try {
      return success(
        !!(await this.db
          .query()('cruxes')
          .where({ id })
          .whereNull('deleted')
          .first('id')),
      );
    } catch (error) {
      return failure<boolean>(error);
    }
  }

  async node(id: string) {
    try {
      const row = await this.db.query()('cruxes').where({ id }).first();
      return success(row ? (toEntityFields(row) as CapturedRecord) : null);
    } catch (error) {
      return failure<CapturedRecord | null>(error);
    }
  }

  async rows(
    table:
      | 'dimensions'
      | 'working_copies'
      | 'task_merges'
      | 'store'
      | 'file_content_heads'
      | 'edit_history',
    ids: string[],
  ) {
    try {
      const column = table === 'dimensions' ? 'source_id' : 'crux_id';
      const rows: CapturedRecord[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const query = this.db
          .query()(table)
          .whereIn(column, ids.slice(i, i + 200));
        if (table === 'dimensions') query.whereNull('deleted');
        rows.push(
          ...(await query).map((row) => toEntityFields(row) as CapturedRecord),
        );
      }
      return success(
        rows.sort((a, b) =>
          String(a.id ?? a.cruxId).localeCompare(String(b.id ?? b.cruxId)),
        ),
      );
    } catch (error) {
      return failure<CapturedRecord[]>(error);
    }
  }

  async contentAvailable(ids: string[]) {
    try {
      const db = this.db.query();
      for (let i = 0; i < ids.length; i += 200) {
        const selected = ids.slice(i, i + 200);
        if (await db('artifacts').whereIn('resource_id', selected).first('id'))
          throw new Error(
            'Selected graph still contains per-file database records',
          );
        if (
          await db('settings')
            .whereIn(
              'key',
              selected.map((id) => `cruxgarden:content-projection:${id}`),
            )
            .first('key')
        )
          throw new Error(
            'Finish selected workspace recovery before capturing its graph',
          );
      }
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }
}
