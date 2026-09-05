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
  // Only ever writes in the rate-limit test, so its bucket starts empty there.
  const CAROL = { account: 'acct-carol', author: 'author-carol' };
  const accounts = [OWNER, ALICE, BOB, CAROL];

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
    delete process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT;
  });

  describe('every write needs a signed-in account', () => {
    it('PUT without a token is 401 with one plain message, public or protected', async () => {
      for (const mode of ['public', 'protected', undefined]) {
        const res = await request(app.getHttpServer())
          .put(url('board'))
          .send(mode ? { value: ['alice'], mode } : { value: ['alice'] })
          .expect(401);
        expect(res.body.message).toBe(
          'Writing to the store requires a signed-in account',
        );
      }
      expect(store.rows).toHaveLength(0);
    });

    it('increment and delete without a token are 401 too', async () => {
      await request(app.getHttpServer())
        .put(url('hits'))
        .set(auth(ALICE.account))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      const inc = await request(app.getHttpServer())
        .post(`${url('hits')}/inc`)
        .send({})
        .expect(401);
      expect(inc.body.message).toBe(
        'Writing to the store requires a signed-in account',
      );
      await request(app.getHttpServer()).delete(url('hits')).expect(401);
      expect(store.rows).toHaveLength(1);
      // Reads stay open.
      const read = await request(app.getHttpServer())
        .get(url('hits'))
        .expect(200);
      expect(read.body).toMatchObject({ value: 1, mode: 'public' });
    });
  });

  describe('public keys', () => {
    it('PUT with a token writes the one shared value; GET is open and shaped { value, mode, updatedAt }', async () => {
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(ALICE.account))
        .send({ value: ['alice'], mode: 'public' })
        .expect(200)
        .expect({ value: ['alice'] });

      // Bob overwrites the same shared value — no per-account slot.
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(BOB.account))
        .send({ value: ['alice', 'bob'], mode: 'public' })
        .expect(200);
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].visitor_id).toBeNull();
      expect(store.rows[0].mode).toBe('public');

      const anon = await request(app.getHttpServer())
        .get(url('board'))
        .expect(200);
      expect(anon.body).toMatchObject({
        value: ['alice', 'bob'],
        mode: 'public',
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

    it('increment acts on the shared value for every signed-in caller', async () => {
      await request(app.getHttpServer())
        .post(`${url('plays')}/inc`)
        .set(auth(ALICE.account))
        .send({ by: 2, mode: 'public' })
        .expect(201)
        .expect({ value: 2 });
      await request(app.getHttpServer())
        .post(`${url('plays')}/inc`)
        .set(auth(BOB.account))
        .send({ by: 3 })
        .expect(201)
        .expect({ value: 5 });
      expect(store.rows).toHaveLength(1);
      const res = await request(app.getHttpServer())
        .get(url('plays'))
        .expect(200);
      expect(res.body).toMatchObject({ value: 5, mode: 'public' });
    });

    it('a signed-in visitor removes the shared value', async () => {
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(ALICE.account))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .delete(url('board'))
        .set(auth(BOB.account))
        .expect(204);
      await request(app.getHttpServer())
        .get(url('board'))
        .expect(200)
        .expect({ value: null });
    });

    it('accepts the deprecated mode common as public and never stores it', async () => {
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(ALICE.account))
        .send({ value: ['alice'], mode: 'common' })
        .expect(200)
        .expect({ value: ['alice'] });
      expect(store.rows[0].mode).toBe('public');
      // The alias agrees with a public key, both ways.
      await request(app.getHttpServer())
        .put(url('board'))
        .set(auth(BOB.account))
        .send({ value: ['alice', 'bob'], mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${url('board2')}/inc`)
        .set(auth(BOB.account))
        .send({ mode: 'common' })
        .expect(201)
        .expect({ value: 1 });
      expect(store.rows.map((r) => r.mode)).toEqual(['public', 'public']);
      const read = await request(app.getHttpServer())
        .get(url('board'))
        .expect(200);
      expect(read.body.mode).toBe('public');
    });
  });

  describe('mode is fixed by the first write', () => {
    it('a protected key cannot be reopened as public (409, plain message)', async () => {
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(ALICE.account))
        .send({ value: { theme: 'dark' } })
        .expect(200);
      const res = await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(BOB.account))
        .send({ value: 'leak', mode: 'public' })
        .expect(409);
      expect(res.body.message).toBe(
        'Key "prefs" is protected; it cannot be written as public',
      );
      // Nor through the alias.
      await request(app.getHttpServer())
        .put(url('prefs'))
        .set(auth(BOB.account))
        .send({ value: 'leak', mode: 'common' })
        .expect(409);
      // And the protected key still reads as private.
      await request(app.getHttpServer())
        .get(url('prefs'))
        .expect(200)
        .expect({ value: null });
    });

    it('a public key cannot become protected', async () => {
      await request(app.getHttpServer())
        .put(url('hits'))
        .set(auth(ALICE.account))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .put(url('hits'))
        .set(auth(BOB.account))
        .send({ value: 2, mode: 'protected' })
        .expect(409);
      await request(app.getHttpServer())
        .post(`${url('hits')}/inc`)
        .set(auth(BOB.account))
        .send({ mode: 'protected' })
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

  describe('per-account write rate limit', () => {
    it('answers 429 with a plain message once an account passes STORE_WRITES_PER_MINUTE_PER_ACCOUNT', async () => {
      process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT = '2';
      await request(app.getHttpServer())
        .put(url('hits'))
        .set(auth(CAROL.account))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${url('hits')}/inc`)
        .set(auth(CAROL.account))
        .send({})
        .expect(201);
      const res = await request(app.getHttpServer())
        .delete(url('hits'))
        .set(auth(CAROL.account))
        .expect(429);
      expect(res.body.message).toBe(
        'Too many store writes from this account — try again in a minute',
      );
      expect(store.rows).toHaveLength(1); // the delete never ran
      // Another account is not slowed down (its earlier writes in this file
      // sit under the default limit), and reads are never counted.
      delete process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT;
      await request(app.getHttpServer())
        .put(url('other'))
        .set(auth(BOB.account))
        .send({ value: 1, mode: 'public' })
        .expect(200);
      await request(app.getHttpServer())
        .get(url('hits'))
        .set(auth(CAROL.account))
        .expect(200);
    });
  });

  it('404 for an unknown crux on write', async () => {
    await request(app.getHttpServer())
      .put('/store/nope/k')
      .set(auth(ALICE.account))
      .send({ value: 1, mode: 'public' })
      .expect(404);
  });
});
