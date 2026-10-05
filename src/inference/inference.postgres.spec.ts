/** Optional real-Postgres gate. Uses a fresh unique schema; never touches existing tables.
 * INCLUDED_TEST_DATABASE_URL must point to a disposable loopback PostgreSQL instance.
 */
import knex, { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { InferenceRepository } from './inference.repository';
import { DbService } from '../common/services/db.service';
import { SONNET, HOUR, ALLOWANCES, reservation } from './policy';
import { up } from '../../db/migrations/20260914170000_included_inference';
import { up as attribution } from '../../db/migrations/20261005010000_inference_attribution';
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
      await attribution(db);
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
            [{ model: SONNET, amount: 200000 }],
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
            [{ model: SONNET, amount: 200000 }],
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
            [{ model: SONNET, amount: 500000 }],
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
          [{ model: SONNET, amount: 5000 }],
          ALLOWANCES.gardener,
        ),
        repo.reserve(
          account,
          id,
          [{ model: SONNET, amount: 5000 }],
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
    it('refuses a request the remaining allowance cannot cover', async () => {
      const id = randomUUID();
      await repo.reserve(
        account,
        id,
        [{ model: SONNET, amount: 1_900_000 }],
        ALLOWANCES.gardener_plus,
      );
      await repo.settle(account, id, 1_900_000, null, 'uncertain');
      // One model now, so there is nothing cheaper to fall back to: the
      // account waits for the window rather than being served a lesser model.
      const chosen = await repo.reserve(
        account,
        randomUUID(),
        [{ model: SONNET, amount: 200_000 }],
        ALLOWANCES.gardener_plus,
      );
      expect(chosen.error).toBeTruthy();
      expect(chosen.data).toBeFalsy();
    });
    it('retains interrupted cost after the concurrency lease expires; aging out releases each window', async () => {
      const now = new Date();
      const id = randomUUID();
      await repo.reserve(
        account,
        id,
        [{ model: SONNET, amount: 700000 }],
        ALLOWANCES.gardener,
        new Date(now.getTime() - HOUR),
      );
      expect(
        (
          await repo.reserve(
            account,
            randomUUID(),
            [{ model: SONNET, amount: 100000 }],
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
            [{ model: SONNET, amount: 100000 }],
            ALLOWANCES.gardener,
            new Date(now.getTime() + 5 * HOUR),
          )
        ).data,
      ).toBeTruthy();
      expect(
        (await repo.rows(account, new Date(now.getTime() + 726 * HOUR))).data,
      ).toEqual([]);
    });
    it('clamps the output budget to what remains, attributes the row, and refuses below the minimum', async () => {
      const crux = randomUUID();
      const used = randomUUID();
      await repo.reserve(
        account,
        used,
        [{ model: SONNET, amount: 600_000 }],
        ALLOWANCES.gardener,
      );
      await repo.settle(account, used, 600_000, null, 'uncertain');
      const input = 20_000;
      const full = reservation(SONNET, input, 8192);
      const clamped = await repo.reserve(
        account,
        randomUUID(),
        [{ model: SONNET, amount: full, input, output: 8192 }],
        ALLOWANCES.gardener,
        new Date(),
        { cruxId: crux, kind: 'chat' },
      );
      expect(clamped.data!.maxTokens).toBeLessThan(8192);
      expect(clamped.data!.amount).toBeLessThanOrEqual(150_000);
      const rows = (await repo.rows(account)).data!;
      expect(rows[1]).toMatchObject({ crux_id: crux, kind: 'chat' });
      const refused = await repo.reserve(
        account,
        randomUUID(),
        [{ model: SONNET, amount: full, input, output: 8192 }],
        ALLOWANCES.gardener,
      );
      expect(refused.error).toBeTruthy();
    });
    it('sweeps only stale reservations and adjusts only downwards, once settled', async () => {
      const old = randomUUID();
      const fresh = randomUUID();
      await repo.reserve(
        account,
        old,
        [{ model: SONNET, amount: 9000 }],
        ALLOWANCES.gardener,
        new Date(Date.now() - HOUR),
      );
      await repo.reserve(
        account,
        fresh,
        [{ model: SONNET, amount: 9000 }],
        ALLOWANCES.gardener,
      );
      await repo.progress(account, old, {
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
      const stale = (await repo.stale(new Date(Date.now() - 15 * 60_000)))
        .data!;
      expect(stale.map((r) => r.id)).toEqual([old]);
      expect(stale[0].input_tokens).toBe(10);
      expect(
        (await repo.adjust(fresh, 1, 'still running', account)).data,
      ).toBeNull();
      await repo.settle(account, fresh, 9000, null, 'uncertain');
      expect(
        (await repo.adjust(fresh, 9500, 'raise', account)).data,
      ).toBeNull();
      const lowered = (await repo.adjust(fresh, 2000, 'refund', account)).data!;
      expect(Number(lowered.charged_microdollars)).toBe(2000);
      expect(Number(lowered.adjusted_from_microdollars)).toBe(9000);
      await repo.adjust(fresh, 1000, 'again', account);
      const again = (await repo.find(fresh)).data!;
      expect(Number(again.adjusted_from_microdollars)).toBe(9000);
      expect(Number(again.charged_microdollars)).toBe(1000);
    });
  },
);
