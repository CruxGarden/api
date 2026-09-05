import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { CruxRepository } from '../src/crux/crux.repository';
import { AuthorRepository } from '../src/author/author.repository';
import { StoreRepository } from '../src/crux-store/crux-store.repository';
import { UsageService } from '../src/usage/usage.service';
import { HomeService } from '../src/home/home.service';
import { DbService } from '../src/common/services/db.service';
import { RedisService } from '../src/common/services/redis.service';
import { MockDbService } from './mocks/db.mock';
import { MockRedisService } from './mocks/redis.mock';
import { success } from '../src/common/helpers/repository-helpers';
import StoreRaw from '../src/crux-store/entities/crux-store-raw.entity';
import { StoreMode } from '../src/crux-store/entities/crux-store.entity';

/**
 * In-memory stand-in for StoreRepository with the same row semantics as the
 * Postgres table: one shared row per key (visitor_id NULL) and one row per
 * (visitor, key) for protected slots. Lets the real controller, service,
 * guards and pipes run end to end.
 */
class FakeStoreRepository {
  rows: StoreRaw[] = [];
  private seq = 0;

  private shared(cruxId: string, key: string) {
    return this.rows.find(
      (r) => r.crux_id === cruxId && r.key === key && r.visitor_id === null,
    );
  }
  private slot(cruxId: string, key: string, visitorId: string) {
    return this.rows.find(
      (r) =>
        r.crux_id === cruxId && r.key === key && r.visitor_id === visitorId,
    );
  }

  async findKeyModes(cruxId: string, key: string) {
    const modes = new Set<StoreMode>();
    for (const r of this.rows)
      if (r.crux_id === cruxId && r.key === key) modes.add(r.mode);
    return success([...modes]);
  }
  async findSharedEntry(cruxId: string, key: string) {
    return success(this.shared(cruxId, key) ?? null);
  }
  async findProtectedEntry(cruxId: string, key: string, visitorId: string) {
    return success(this.slot(cruxId, key, visitorId) ?? null);
  }
  async findAllByCrux(cruxId: string) {
    return success(this.rows.filter((r) => r.crux_id === cruxId));
  }
  async upsertShared(
    id: string,
    cruxId: string,
    authorId: string,
    key: string,
    value: any,
    mode: StoreMode,
  ) {
    const now = new Date(Date.now() + this.seq++);
    const existing = this.shared(cruxId, key);
    if (existing) {
      existing.value = value;
      existing.updated_at = now;
      return success(existing);
    }
    const row: StoreRaw = {
      id,
      crux_id: cruxId,
      author_id: authorId,
      visitor_id: null,
      key,
      value,
      mode,
      created_at: now,
      updated_at: now,
    };
    this.rows.push(row);
    return success(row);
  }
  async upsertProtected(
    id: string,
    cruxId: string,
    authorId: string,
    visitorId: string,
    key: string,
    value: any,
  ) {
    const now = new Date(Date.now() + this.seq++);
    const existing = this.slot(cruxId, key, visitorId);
    if (existing) {
      existing.value = value;
      existing.updated_at = now;
      return success(existing);
    }
    const row: StoreRaw = {
      id,
      crux_id: cruxId,
      author_id: authorId,
      visitor_id: visitorId,
      key,
      value,
      mode: 'protected',
      created_at: now,
      updated_at: now,
    };
    this.rows.push(row);
    return success(row);
  }
  async atomicIncrement(
    cruxId: string,
    key: string,
    by: number,
    visitorId?: string | null,
  ) {
    const row = visitorId
      ? this.slot(cruxId, key, visitorId)
      : this.shared(cruxId, key);
    if (!row) return success(null);
    row.value = Number(row.value ?? 0) + by;
    row.updated_at = new Date();
    return success(row);
  }
  async deleteEntry(cruxId: string, key: string, visitorId?: string | null) {
    this.rows = this.rows.filter(
      (r) =>
        !(
          r.crux_id === cruxId &&
          r.key === key &&
          r.visitor_id === (visitorId ?? null)
        ),
    );
    return success(undefined);
  }
  async deleteKey(cruxId: string, key: string) {
    this.rows = this.rows.filter(
      (r) => !(r.crux_id === cruxId && r.key === key),
    );
    return success(undefined);
  }
  async clearAllByCrux(cruxId: string) {
    this.rows = this.rows.filter((r) => r.crux_id !== cruxId);
    return success(undefined);
  }
  async getStorageByAuthor() {
    return success(0);
  }
}

describe('Crux Store Integration Tests', () => {
  let app: INestApplication;
  let store: FakeStoreRepository;
  let usage: Record<string, jest.Mock>;

  const CRUX = 'crux-store-1';
  const OWNER = { account: 'acct-owner', author: 'author-owner' };
  const ALICE = { account: 'acct-alice', author: 'author-alice' };
  const BOB = { account: 'acct-bob', author: 'author-bob' };
  const accounts = [OWNER, ALICE, BOB];

  const token = (accountId: string) =>
    jwt.sign(
      { id: accountId, email: `${accountId}@example.com`, role: 'author' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' },
    );
  const auth = (accountId: string) => ({
    Authorization: `Bearer ${token(accountId)}`,
  });
  const url = (key: string) => `/store/${CRUX}/${key}`;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    store = new FakeStoreRepository();
    usage = {
      noteStoreRequest: jest.fn(),
      flushStoreCounts: jest.fn(),
      stopScheduler: jest.fn(),
    };

    const cruxRepository = {
      findBy: jest.fn(async (field: string, value: string) =>
        success(
          field === 'id' && value === CRUX
            ? {
                id: CRUX,
                slug: 'store-crux',
                title: 'Store Crux',
                data: '',
                type: 'webapp',
                status: 'living',
                visibility: 'public',
                author_id: OWNER.author,
                home_id: 'home-1',
                created: new Date(),
                updated: new Date(),
                deleted: null,
              }
            : null,
        ),
      ),
    };
    const authorRepository = {
      findBy: jest.fn(async (field: string, value: string) => {
        const hit = accounts.find((a) =>
          field === 'account_id' ? a.account === value : a.author === value,
        );
        return success(
          hit
            ? {
                id: hit.author,
                account_id: hit.account,
                username: hit.author.replace('author-', ''),
                display_name: hit.author,
                created: new Date(),
                updated: new Date(),
                deleted: null,
              }
            : null,
        );
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbService)
      .useValue(new MockDbService())
      .overrideProvider(RedisService)
      .useValue(new MockRedisService())
      .overrideProvider(CruxRepository)
      .useValue(cruxRepository)
      .overrideProvider(AuthorRepository)
      .useValue(authorRepository)
      .overrideProvider(StoreRepository)
      .useValue(store)
      .overrideProvider(UsageService)
      .useValue(usage)
      .overrideProvider(HomeService)
      .useValue({ primary: jest.fn().mockResolvedValue({ id: 'home-1' }) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.rows = [];
    usage.noteStoreRequest.mockClear();
  });

  describe('common keys', () => {
    it('PUT without a token is 401 with a plain message', async () => {
      const res = await request(app.getHttpServer())
        .put(url('board'))
        .send({ value: ['alice'], mode: 'common' })
        .expect(401);
      expect(res.body.message).toBe(
        'Common keys require a signed-in account to write',
      );
      expect(store.rows).toHaveLength(0);
    });

    it('PUT with a token writes the one shared value; GET is public and shaped like a public read', async () => {
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(ALICE.account))
        .send({ value: ['alice'], mode: 'common' })
        .expect(200)
        .expect({ value: ['alice'] });

      // Bob overwrites the same shared value — no per-account slot.
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(BOB.account))
        .send({ value: ['alice', 'bob'], mode: 'common' })
        .expect(200);
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].visitor_id).toBeNull();
      expect(store.rows[0].mode).toBe('common');

      const anon = await request(app.getHttpServer())
        .get(url('board'))
        .expect(200);
      expect(anon.body).toMatchObject({
        value: ['alice', 'bob'],
        mode: 'common',
      });
      expect(typeof anon.body.updatedAt).toBe('string');
      expect(Object.keys(anon.body).sort()).toEqual([
        'mode',
        'updatedAt',
        'value',
      ]);

      const signedIn = await request(app.getHttpServer())
        .get(url('board'))
        .set(auth(BOB.account))
        .expect(200);
      expect(signedIn.body.value).toEqual(['alice', 'bob']);

      expect(usage.noteStoreRequest).toHaveBeenCalledWith(CRUX, 'write');
      expect(usage.noteStoreRequest).toHaveBeenCalledWith(CRUX, 'read');
    });

    it('increment needs a token and acts on the shared value', async () => {
      await request(app.getHttpServer())
        .post(`${url('plays')}/inc`)
        .send({ by: 1, mode: 'common' })
        .expect(401);

      await request(app.getHttpServer())
        .post(`${url('plays')}/inc`)
        .set(auth(ALICE.account))
        .send({ by: 2, mode: 'common' })
        .expect(201)
        .expect({ value: 2 });
      await request(app.getHttpServer())
        .post(`${url('plays')}/inc`)
        .set(auth(BOB.account))
        .send({ by: 3 })
        .expect(201)
        .expect({ value: 5 });
      // Once the key is common, anonymous increments are refused too.
      await request(app.getHttpServer())
        .post(`${url('plays')}/inc`)
        .send({})
        .expect(401);
      expect(store.rows).toHaveLength(1);
    });

    it('delete needs a token; a visitor removes the shared value', async () => {
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(ALICE.account))
        .send({ value: 1, mode: 'common' })
        .expect(200);
      await request(app.getHttpServer()).delete(url('board')).expect(401);
      await request(app.getHttpServer())
        .delete(url('board'))
        .set(auth(BOB.account))
        .expect(204);
      await request(app.getHttpServer())
        .get(url('board'))
        .expect(200)
        .expect({ value: null });
    });
  });

  describe('mode is fixed by the first write', () => {
    it('a protected key cannot be reopened as common (409, plain message)', async () => {
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(ALICE.account))
        .send({ value: { theme: 'dark' } })
        .expect(200);
      const res = await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(BOB.account))
        .send({ value: 'leak', mode: 'common' })
        .expect(409);
      expect(res.body.message).toBe(
        'Key "prefs" is protected; it cannot be written as common',
      );
      // And the protected key still reads as private.
      await request(app.getHttpServer())
        .get(url('prefs'))
        .expect(200)
        .expect({ value: null });
    });

    it('a common key cannot be reopened as public, and a public key cannot become common', async () => {
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(ALICE.account))
        .send({ value: 1, mode: 'common' })
        .expect(200);
      await request(app.getHttpServer())
        .put(url('board'))
        .send({ value: 2, mode: 'public' })
        .expect(409);
      await request(app.getHttpServer())
        .post(`${url('board')}/inc`)
        .send({ mode: 'public' })
        .expect(409);

      await request(app.getHttpServer())
        .put(url('hits'))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .put(url('hits'))
        .set(auth(ALICE.account))
        .send({ value: 2, mode: 'common' })
        .expect(409);
    });

    it('rejects an unknown mode (400)', async () => {
      await request(app.getHttpServer())
        .put(url('k'))
        .set(auth(ALICE.account))
        .send({ value: 1, mode: 'authenticated' })
        .expect(400);
    });
  });

  describe('protected stays self-only', () => {
    it('each account reads only its own slot; anonymous and others get null', async () => {
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(ALICE.account))
        .send({ value: 'alice-prefs', mode: 'protected' })
        .expect(200);
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(BOB.account))
        .send({ value: 'bob-prefs' })
        .expect(200);
      expect(store.rows).toHaveLength(2);

      const alice = await request(app.getHttpServer())
        .get(url('prefs'))
        .set(auth(ALICE.account))
        .expect(200);
      expect(alice.body).toMatchObject({
        value: 'alice-prefs',
        mode: 'protected',
      });
      const bob = await request(app.getHttpServer())
        .get(url('prefs'))
        .set(auth(BOB.account))
        .expect(200);
      expect(bob.body.value).toBe('bob-prefs');
      await request(app.getHttpServer())
        .get(url('prefs'))
        .expect(200)
        .expect({ value: null });
      await request(app.getHttpServer())
        .put(url('prefs'))
        .send({ value: 'x' })
        .expect(401);
    });

    it('a visitor’s delete removes only their own slot; the author’s delete removes every slot', async () => {
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(ALICE.account))
        .send({ value: 1 })
        .expect(200);
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(BOB.account))
        .send({ value: 2 })
        .expect(200);

      await request(app.getHttpServer())
        .delete(url('prefs'))
        .set(auth(ALICE.account))
        .expect(204);
      expect(store.rows.map((r) => r.visitor_id)).toEqual([BOB.author]);

      await request(app.getHttpServer())
        .delete(url('prefs'))
        .set(auth(OWNER.account))
        .expect(204);
      expect(store.rows).toHaveLength(0);
    });
  });

  describe('public keys (unchanged)', () => {
    it('anyone writes, increments and reads the shared value', async () => {
      await request(app.getHttpServer())
        .put(url('hits'))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${url('hits')}/inc`)
        .send({})
        .expect(201)
        .expect({ value: 2 });
      // A signed-in visitor increments the same shared value, not a private slot.
      await request(app.getHttpServer())
        .post(`${url('hits')}/inc`)
        .set(auth(ALICE.account))
        .send({})
        .expect(201)
        .expect({ value: 3 });
      expect(store.rows).toHaveLength(1);
      const res = await request(app.getHttpServer())
        .get(url('hits'))
        .set(auth(BOB.account))
        .expect(200);
      expect(res.body).toMatchObject({ value: 3, mode: 'public' });
    });
  });

  it('404 for an unknown crux on write', async () => {
    await request(app.getHttpServer())
      .put('/store/nope/k')
      .send({ value: 1, mode: 'public' })
      .expect(404);
  });
});
