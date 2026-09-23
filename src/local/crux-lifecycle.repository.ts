import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';

const historyReferences = [
  'SELECT source_id, target_id FROM dimensions',
  ...['cruxes', 'working_copies'].flatMap((table) =>
    [
      'parentCruxId',
      'settings.activeBranch',
      'merge.sourceHead',
      'merge.targetHead',
      'merge.baseId',
    ].map((path) => `SELECT id, json_extract(meta, '$.${path}') FROM ${table}`),
  ),
  'SELECT id, base_snapshot_id FROM working_copies',
  'SELECT crux_id, candidate_id FROM task_merges',
  ...['sourceHead', 'targetHead', 'resultHead', 'baseId'].map(
    (path) =>
      `SELECT crux_id, json_extract(data, '$.${path}') FROM task_merges`,
  ),
].join('\nUNION\n');

/** Desktop ownership/retention queries; every call uses the admitted API transaction. */
@Injectable()
export class CruxLifecycleRepository {
  constructor(private readonly db: DbService) {}

  async inspect(id: string) {
    try {
      const copy = await this.db
        .query()('working_copies')
        .where({ id })
        .first('id');
      const crux = await this.db
        .query()('cruxes')
        .where({ id })
        .first('id', 'deleted');
      return success<{
        copy: boolean;
        crux?: { id: string; deleted: string | null };
      }>({ copy: !!copy, crux });
    } catch (error) {
      return failure<{
        copy: boolean;
        crux?: { id: string; deleted: string | null };
      }>(error);
    }
  }
  async setTrashed(id: string, trashed: boolean) {
    try {
      const query = this.db.query()('cruxes').where({ id });
      await (
        trashed ? query.whereNull('deleted') : query.whereNotNull('deleted')
      ).update({ deleted: trashed ? new Date().toISOString() : null });
      const saved = await this.db
        .query()('cruxes')
        .where({ id })
        .first('deleted');
      if (!saved || (saved.deleted !== null) !== trashed)
        throw new Error('Incomplete Crux lifecycle update');
      return success({ saved: true });
    } catch (error) {
      return failure<{ saved: boolean }>(error);
    }
  }
  async references(id: string) {
    try {
      const history = await this.db.query().raw(
        `
    WITH RECURSIVE roots(id) AS (
      SELECT base_snapshot_id FROM working_copies
      UNION SELECT candidate_id FROM task_merges
      UNION SELECT json_extract(meta, '$.merge.baseId') FROM cruxes
      UNION SELECT json_extract(meta, '$.merge.sourceHead') FROM cruxes
      UNION SELECT json_extract(meta, '$.merge.targetHead') FROM cruxes
      UNION SELECT json_extract(data, '$.sourceHead') FROM task_merges
      UNION SELECT json_extract(data, '$.targetHead') FROM task_merges
      UNION SELECT json_extract(data, '$.resultHead') FROM task_merges
      UNION SELECT json_extract(data, '$.baseId') FROM task_merges
    ), links(parent, child) AS (
      SELECT json_extract(meta, '$.parentCruxId'), id FROM cruxes
      UNION SELECT json_extract(meta, '$.merge.sourceHead'), id FROM cruxes
      UNION SELECT json_extract(meta, '$.merge.targetHead'), id FROM cruxes
    ), ancestry(id) AS (
      SELECT id FROM roots WHERE id IS NOT NULL
      UNION SELECT links.parent FROM links JOIN ancestry ON links.child = ancestry.id WHERE links.parent IS NOT NULL
    ) SELECT id FROM ancestry WHERE id = ? LIMIT 1`,
        [id],
      );
      const shared = await this.db.query().raw(
        `WITH refs(origin, target) AS (${historyReferences})
    SELECT c.id FROM cruxes c WHERE c.id = ? AND c.kind = 'snapshot' AND (
      (SELECT COUNT(DISTINCT source_id) FROM dimensions
        WHERE target_id = c.id AND type = 'growth') > 1
      OR EXISTS (SELECT 1 FROM dimensions d WHERE d.target_id = c.id AND (
        d.type != 'growth' OR (json_extract(c.meta, '$.contentOwnerId') IS NOT NULL
          AND json_extract(c.meta, '$.contentOwnerId') != d.source_id)))
      OR EXISTS (SELECT 1 FROM refs r WHERE r.target = c.id AND r.origin != c.id
        AND r.origin NOT IN (SELECT source_id FROM dimensions
          WHERE target_id = c.id AND type = 'growth'))
    )`,
        [id],
      );
      return success({
        history: history.length > 0,
        shared: shared.length > 0,
      });
    } catch (error) {
      return failure<{ history: boolean; shared: boolean }>(error);
    }
  }
  async plan(id: string) {
    try {
      const rows = await this.db.query().raw(
        `WITH RECURSIVE
    owners(id) AS (
      SELECT ? UNION SELECT id FROM working_copies WHERE crux_id = ?
    ), candidates(id) AS (
      SELECT c.id FROM cruxes c
      JOIN dimensions d ON d.target_id = c.id
      WHERE d.source_id IN (SELECT id FROM owners)
        AND d.type = 'growth' AND c.kind = 'snapshot'
        AND c.id NOT IN (SELECT id FROM owners)
        AND (json_extract(c.meta, '$.contentOwnerId') IS NULL
          OR json_extract(c.meta, '$.contentOwnerId') = d.source_id)
    ), refs(origin, target) AS (${historyReferences}), retained(id) AS (
      SELECT r.target FROM refs r JOIN candidates c ON c.id = r.target
      WHERE r.origin NOT IN (SELECT id FROM owners)
        AND r.origin NOT IN (SELECT id FROM candidates)
      UNION
      SELECT r.target FROM refs r
      JOIN retained p ON p.id = r.origin
      JOIN candidates c ON c.id = r.target
    )
    SELECT id FROM owners
    UNION SELECT id FROM candidates WHERE id NOT IN (SELECT id FROM retained)`,
        [id, id],
      );
      return success<{ ids: string[] }>({
        ids: rows.map((row: { id: string }) => row.id),
      });
    } catch (error) {
      return failure<{ ids: string[] }>(error);
    }
  }
  async purge(id: string, ids: string[]) {
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        await this.db
          .query()('artifacts')
          .whereIn('resource_id', chunk)
          .delete();
        await this.db.query()('store').whereIn('crux_id', chunk).delete();
        await this.db
          .query()('dimensions')
          .whereIn('source_id', chunk)
          .orWhereIn('target_id', chunk)
          .delete();
        await this.db.query()('cruxes').whereIn('id', chunk).delete();
      }
      await this.db.query()('working_copies').where({ crux_id: id }).delete();
      await this.db.query()('task_merges').where({ crux_id: id }).delete();
      // SQLite RAISE(IGNORE) can suppress a delete without rejecting it. Check
      // the complete postcondition before committing, including earlier chunks.
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        for (const [table, column] of [
          ['artifacts', 'resource_id'],
          ['store', 'crux_id'],
          ['cruxes', 'id'],
        ])
          if (await this.db.query()(table).whereIn(column, chunk).first('id'))
            throw new Error('Incomplete Crux deletion');
        if (
          await this.db
            .query()('dimensions')
            .whereIn('source_id', chunk)
            .orWhereIn('target_id', chunk)
            .first('id')
        )
          throw new Error('Incomplete Crux deletion');
      }
      for (const table of ['working_copies', 'task_merges'])
        if (await this.db.query()(table).where({ crux_id: id }).first('id'))
          throw new Error('Incomplete Crux deletion');
      return success({ purged: true });
    } catch (error) {
      return failure<{ purged: boolean }>(error);
    }
  }
}
