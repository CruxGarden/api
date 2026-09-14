/** Optional real-Postgres gate. Uses a fresh unique schema; never touches existing tables.
 * INCLUDED_TEST_DATABASE_URL must point to a disposable loopback PostgreSQL instance.
 */
import knex, { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { InferenceRepository } from './inference.repository';
import { DbService } from '../common/services/db.service';
import { HAIKU, SONNET, HOUR, ALLOWANCES } from './policy';
import { up } from '../../db/migrations/20260914170000_included_inference';
const url = process.env.INCLUDED_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'Included allowance with real PostgreSQL transactions',
  () => {
    let admin: Knex;
    let db: Knex;
    let repo: InferenceRepository;
    const schema = `inference_test_${randomUUID().replace(/-/g, '')}`;
    const account = randomUUID();
    const another = randomUUID();
    beforeAll(async () => {
      if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error('Use an isolated loopback test database.');
      admin = knex({ client: 'pg', connection: url });
      await admin.schema.createSchema(schema);
      db = knex({
        client: 'pg',
        connection: url,
        searchPath: [schema],
        pool: { min: 0, max: 8 },
      });
      await db.schema.createTable('accounts', (t) => t.uuid('id').primary());
      await db('accounts').insert([{ id: account }, { id: another }]);
      await up(db);
      repo = new InferenceRepository({
        query: () => db,
      } as unknown as DbService);
    });
    beforeEach(async () => {
      await db('inference_requests').delete();
    });
    afterAll(async () => {
      if (db) await db.destroy();
      if (admin) {
        await admin.schema.dropSchemaIfExists(schema, true);
        await admin.destroy();
      }
    });
    it('serializes simultaneous requests: only two start and an independent account is unaffected', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.reserve(
            account,
            randomUUID(),
            [{ model: HAIKU, amount: 200000 }],
            ALLOWANCES.gardener,
          ),
        ),
      );
      expect(attempts.filter((r) => r.data)).toHaveLength(2);
      expect(attempts.filter((r) => r.error)).toHaveLength(6);
      expect(
        (
          await repo.reserve(
            another,
            randomUUID(),
            [{ model: HAIKU, amount: 200000 }],
            ALLOWANCES.gardener,
          )
        ).error,
      ).toBeNull();
      expect((await repo.rows(account)).data).toHaveLength(2);
    });
    it('enforces money limits across processes, even below the concurrency cap', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          repo.reserve(
            account,
            randomUUID(),
            [{ model: HAIKU, amount: 500000 }],
            ALLOWANCES.gardener,
          ),
        ),
      );
      expect(attempts.filter((r) => r.data)).toHaveLength(1);
    });
    it('prevents double spending with a repeated request ID and settles exactly once', async () => {
      const id = randomUUID();
      const attempts = await Promise.all([
        repo.reserve(
          account,
          id,
          [{ model: HAIKU, amount: 5000 }],
          ALLOWANCES.gardener,
        ),
        repo.reserve(
          account,
          id,
          [{ model: HAIKU, amount: 5000 }],
          ALLOWANCES.gardener,
        ),
      ]);
      expect(attempts.filter((r) => r.data)).toHaveLength(1);
      await repo.settle(
        account,
        id,
        200,
        { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        'complete',
      );
      await repo.settle(account, id, 9000, null, 'uncertain');
      expect(
        Number((await repo.rows(account)).data![0].charged_microdollars),
      ).toBe(200);
    });
    it('falls back from Sonnet without exceeding the shared account allowance', async () => {
      const id = randomUUID();
      await repo.reserve(
        account,
        id,
        [{ model: SONNET, amount: 1490000 }],
        ALLOWANCES.gardener_plus,
      );
      await repo.settle(account, id, 1490000, null, 'uncertain');
      const chosen = await repo.reserve(
        account,
        randomUUID(),
        [
          { model: SONNET, amount: 30000 },
          { model: HAIKU, amount: 15000 },
        ],
        ALLOWANCES.gardener_plus,
      );
      expect(chosen.data?.model).toBe(HAIKU);
    });
    it('retains interrupted cost after the concurrency lease expires; aging out releases each window', async () => {
      const now = new Date();
      const id = randomUUID();
      await repo.reserve(
        account,
        id,
        [{ model: HAIKU, amount: 700000 }],
        ALLOWANCES.gardener,
        new Date(now.getTime() - HOUR),
      );
      expect(
        (
          await repo.reserve(
            account,
            randomUUID(),
            [{ model: HAIKU, amount: 100000 }],
            ALLOWANCES.gardener,
            now,
          )
        ).error,
      ).toBeTruthy();
      expect(
        (
          await repo.reserve(
            account,
            randomUUID(),
            [{ model: HAIKU, amount: 100000 }],
            ALLOWANCES.gardener,
            new Date(now.getTime() + 5 * HOUR),
          )
        ).data,
      ).toBeTruthy();
      expect(
        (await repo.rows(account, new Date(now.getTime() + 726 * HOUR))).data,
      ).toEqual([]);
    });
  },
);
