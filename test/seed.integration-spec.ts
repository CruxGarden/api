import knex, { Knex } from 'knex';
import { seed } from '../db/seeds/common/00_seed_common';
import { sqliteGraphConfig } from '../src/common/database/sqlite-graph';

describe('explicit initial administrator seed', () => {
  let db: Knex;
  const originalEnv = { ...process.env };
  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      NURSERY_MODE: 'false',
    };
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.BOOTSTRAP_ADMIN_USERNAME;
    db = knex(sqliteGraphConfig(':memory:'));
    await db.schema.createTable('homes', (t) => {
      t.string('id').primary();
      t.string('name');
      t.string('description');
      t.boolean('primary');
      t.string('type');
      t.string('kind');
      t.json('meta');
      t.timestamp('created');
      t.timestamp('updated');
      t.timestamp('deleted');
    });
    await db.schema.createTable('accounts', (t) => {
      t.string('id').primary();
      t.string('email').unique();
      t.string('role');
      t.string('home_id');
      t.timestamp('deleted');
      t.timestamp('updated');
    });
    await db.schema.createTable('authors', (t) => {
      t.string('id').primary();
      t.string('username').unique();
      t.string('display_name');
      t.string('bio');
      t.string('root_id');
      t.string('account_id').references('accounts.id');
      t.string('home_id');
      t.timestamp('created');
      t.timestamp('updated');
      t.timestamp('deleted');
    });
  });
  afterEach(async () => {
    await db.destroy();
    process.env = { ...originalEnv };
  });

  it('initializes the Home without creating a privileged account by default', async () => {
    await seed(db);
    await seed(db);
    expect(await db('homes')).toHaveLength(1);
    expect(await db('accounts')).toEqual([]);
    expect(await db('authors')).toEqual([]);
  });

  it('creates a random operator identity only when an email is configured and is repeatable', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'operator@example.test';
    await seed(db);
    await seed(db);
    const accounts = await db('accounts');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      email: 'operator@example.test',
      role: 'admin',
    });
    expect(accounts[0].id).not.toBe('d7f5c645-6b4e-4c3b-a5cb-3fd81c652b96');
    const authors = await db('authors');
    expect(authors).toHaveLength(1);
    expect(authors[0].account_id).toBe(accounts[0].id);
  });

  it('uses the existing account identity instead of linking an author to a fixed UUID', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'operator@example.test';
    await db('accounts').insert({
      id: 'existing-operator',
      email: 'operator@example.test',
      role: 'author',
    });
    await seed(db);
    expect(await db('accounts')).toHaveLength(1);
    expect((await db('accounts').first()).role).toBe('admin');
    expect((await db('authors').first()).account_id).toBe('existing-operator');
  });

  it('retains the fixed Nursery identity only with a non-production opt-in', async () => {
    process.env.NODE_ENV = 'development';
    process.env.NURSERY_MODE = 'true';
    await seed(db);
    await seed(db);
    expect(await db('accounts')).toEqual([
      expect.objectContaining({
        id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
        email: 'keeper@crux.garden',
        role: 'keeper',
      }),
    ]);
  });

  it('refuses production Nursery configuration before writing anything', async () => {
    process.env.NURSERY_MODE = 'true';
    await expect(seed(db)).rejects.toThrow(
      'NURSERY_MODE cannot be enabled in production',
    );
    expect(await db('homes')).toEqual([]);
  });
  it('rolls back privilege changes if the requested author name belongs to someone else', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'operator@example.test';
    await db('accounts').insert([
      {
        id: 'existing-operator',
        email: 'operator@example.test',
        role: 'author',
      },
      { id: 'other', email: 'other@example.test', role: 'author' },
    ]);
    await db('authors').insert({
      id: 'other-author',
      username: 'keeper',
      account_id: 'other',
    });
    await expect(seed(db)).rejects.toThrow(
      'Bootstrap username already belongs',
    );
    expect(
      (await db('accounts').where({ id: 'existing-operator' }).first()).role,
    ).toBe('author');
    expect(await db('homes')).toEqual([]);
  });
});
