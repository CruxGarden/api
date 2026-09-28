import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DbService } from '../../src/common/services/db.service';
import { LoggerService } from '../../src/common/services/logger.service';

const exec = promisify(execFile);

/** A disposable server with the production schema; never uses an existing database or .env. */
export async function postgresFixture() {
  const password = randomBytes(24).toString('hex');
  const { stdout } = await exec(
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--publish',
      '127.0.0.1::5432',
      '--label',
      'cruxgarden.fixture=api-tests',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      'postgres:16-alpine',
    ],
    { timeout: 60_000 },
  );
  const container = stdout.trim();
  let db: DbService | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await db?.onModuleDestroy();
    } finally {
      await exec('docker', ['rm', '--force', container]);
    }
  };
  try {
    const published = await exec('docker', ['port', container, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(published.stdout);
    if (!match)
      throw new Error('PostgreSQL fixture must bind only to loopback');
    db = new DbService(new LoggerService(), {
      client: 'pg',
      connection: {
        host: '127.0.0.1',
        port: Number(match[1]),
        user: 'postgres',
        password,
        database: 'postgres',
      },
      pool: { min: 0, max: 2 },
      acquireConnectionTimeout: 1000,
    });
    const deadline = Date.now() + 20_000;
    while (true) {
      try {
        await db.query().raw('SELECT 1');
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
    const directory = join(__dirname, '../../db/migrations');
    // Jest loads these through the same TypeScript transformer as application code.
    // Knex records and applies the real migration list in its normal transaction flow.
    await db.query().migrate.latest({
      migrationSource: {
        getMigrations: async () =>
          (await readdir(directory))
            .filter((file) => file.endsWith('.ts'))
            .sort(),
        getMigrationName: (file: string) => file,
        getMigration: async (file: string) => require(join(directory, file)),
      },
    });
    return { db, close };
  } catch (error) {
    await close();
    throw error;
  }
}
