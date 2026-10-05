import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { sqliteGraphConfig } from '../common/database/sqlite-graph';
import { BillingRepository } from '../billing/billing.repository';
import { AccountRepository } from './account.repository';

/** The suspension SQL against a disposable database (ADR 0083). */
describe('account suspension persistence', () => {
  let dir: string;
  let db: DbService;
  let accounts: AccountRepository;
  let billing: BillingRepository;
  const logger = new LoggerService();
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const gone = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-account-suspension-'));
    db = new DbService(logger, sqliteGraphConfig(join(dir, 'api.db')));
    await db.onModuleInit();
    const sql = db.query();
    await sql.schema.createTable('accounts', (t) => {
      t.string('id').primary();
      t.string('email');
      t.string('role');
      t.timestamp('created');
      t.timestamp('updated');
      t.timestamp('deleted');
      t.timestamp('suspended');
      t.text('suspended_reason');
      t.string('suspended_by');
    });
    await sql.schema.createTable('authors', (t) => {
      t.string('id').primary();
      t.string('account_id');
      t.string('username');
      t.timestamp('deleted');
    });
    await sql('accounts').insert([
      { id: a, email: 'Ada@Example.com', role: 'author', created: new Date(1) },
      {
        id: b,
        email: 'bob_100%@example.com',
        role: 'author',
        created: new Date(2),
      },
      {
        id: gone,
        email: 'ada.old@example.com',
        role: 'author',
        deleted: new Date(),
      },
    ]);
    await sql('authors').insert([
      { id: 'author-a', account_id: a, username: 'ada' },
      { id: 'author-b', account_id: b, username: 'bobby' },
    ]);
    accounts = new AccountRepository(db, logger);
    billing = new BillingRepository(db, logger);
  });
  afterEach(async () => {
    await db.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('searches live accounts by email or @username, treating wildcards literally', async () => {
    expect((await accounts.search('ADA')).data!.map((r) => r.id)).toEqual([a]);
    expect((await accounts.search('@bob')).data!.map((r) => r.id)).toEqual([b]);
    expect((await accounts.search('100%')).data!.map((r) => r.id)).toEqual([b]);
    expect((await accounts.search('_')).data!.map((r) => r.id)).toEqual([b]);
    expect((await accounts.search('')).data!.map((r) => r.id)).toEqual([b, a]);
  });

  it('holds and lifts an account; billing reads the hold by account and by author', async () => {
    expect((await billing.accountSuspension(a)).data).toEqual({
      suspended: null,
      reason: null,
    });
    const held = await accounts.setSuspension(a, {
      reason: 'spam',
      operatorId: b,
    });
    expect(held.data).toMatchObject({
      suspended_reason: 'spam',
      suspended_by: b,
    });
    expect((await billing.accountSuspension(a)).data!.suspended).toBeTruthy();
    expect((await billing.authorSuspension('author-a')).data!.reason).toBe(
      'spam',
    );
    expect(
      (await billing.authorSuspension('author-b')).data!.suspended,
    ).toBeNull();
    await accounts.setSuspension(a, null);
    expect((await billing.accountSuspension(a)).data!.suspended).toBeNull();
    expect((await accounts.setSuspension(gone, null)).data).toBeNull();
    expect((await billing.accountSuspension(gone)).data).toBeNull();
  });
});
