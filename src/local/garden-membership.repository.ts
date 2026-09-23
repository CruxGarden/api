import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';
import DimensionRaw from '../dimension/entities/dimension-raw.entity';

export const GARDEN_MEMBERSHIP = 'membership';

/** Local working-graph queries. These do not model people/access membership. */
@Injectable()
export class GardenMembershipRepository {
  constructor(private readonly db: DbService) {}

  private edges() {
    return this.db
      .query()('dimensions')
      .where({ type: 'garden', kind: GARDEN_MEMBERSHIP })
      .whereNull('deleted');
  }

  async find(gardenId: string, memberId: string) {
    try {
      return success<DimensionRaw>(
        await this.edges()
          .where({ source_id: gardenId, target_id: memberId })
          .orderBy('id')
          .first(),
      );
    } catch (error) {
      return failure<DimensionRaw>(error);
    }
  }

  async reaches(source: string, target: string) {
    try {
      // UNION (not UNION ALL) bounds traversal even when old/imported data
      // already has a cycle. Only structural membership participates.
      const rows = await this.db.query().raw(
        `WITH RECURSIVE descendants(id) AS (
        SELECT target_id FROM dimensions WHERE source_id = ?
          AND type = 'garden' AND kind = ? AND deleted IS NULL
        UNION
        SELECT d.target_id FROM dimensions d JOIN descendants p ON d.source_id = p.id
          WHERE d.type = 'garden' AND d.kind = ? AND d.deleted IS NULL
      ) SELECT id FROM descendants WHERE id = ? LIMIT 1`,
        [source, GARDEN_MEMBERSHIP, GARDEN_MEMBERSHIP, target],
      );
      return success({ reachable: rows.length > 0 });
    } catch (error) {
      return failure<{ reachable: boolean }>(error);
    }
  }

  async remove(gardenId: string, memberId: string) {
    try {
      const count = await this.edges()
        .where({ source_id: gardenId, target_id: memberId })
        .update({ deleted: new Date() });
      return success({ removed: count });
    } catch (error) {
      return failure<{ removed: number }>(error);
    }
  }

  async list(gardenId: string, limit: number, after?: string) {
    try {
      // Keep payloads out of navigation. IDs provide a stable bounded cursor;
      // presentation ordering can be layered on the later Navigator contract.
      const query = this.db
        .query()('dimensions as d')
        .join('cruxes as c', 'c.id', 'd.target_id')
        .where({
          'd.source_id': gardenId,
          'd.type': 'garden',
          'd.kind': GARDEN_MEMBERSHIP,
        })
        .whereNull('d.deleted')
        .whereNull('c.deleted')
        .where((builder) =>
          builder.whereNull('c.kind').orWhereNot('c.kind', 'snapshot'),
        )
        .distinct('c.id', 'c.title', 'c.slug', 'c.kind')
        .orderBy('c.id')
        .limit(limit + 1);
      if (after) query.where('c.id', '>', after);
      const rows = (await query) as {
        id: string;
        title: string;
        slug: string;
        kind: string | null;
      }[];
      return success(rows);
    } catch (error) {
      return failure<
        { id: string; title: string; slug: string; kind: string | null }[]
      >(error);
    }
  }
}
