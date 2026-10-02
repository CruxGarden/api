import { z } from 'zod';
import { DbService } from '../src/common/services/db.service';
import { LoggerService } from '../src/common/services/logger.service';
import { StoreService } from '../src/common/services/store.service';
import { SyncRepository } from '../src/sync/sync.repository';
import {
  SyncUploadRecovery,
  recoveryStorageConfiguration,
} from '../src/sync/sync-upload-recovery';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'Offline maintenance: reconcile-sync-upload --storage s3|local --account UUID --revision UUID [--apply --writer-drain-confirmed --reason TEXT]\nInspect by default. DATABASE_URL must be supplied by the operator; no .env is loaded.\nBefore applying, stop/drain every API instance and confirm outstanding storage PUTs have settled. Age is not proof.',
    );
    return;
  }
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (['--apply', '--writer-drain-confirmed'].includes(key))
      options[key] = true;
    else if (
      ['--account', '--revision', '--reason', '--storage'].includes(key) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      options[key] = args[++index];
    else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  const storage = recoveryStorageConfiguration(
    options['--storage'],
    process.env,
  );
  const account = z.string().uuid().parse(options['--account']);
  const revision = z.string().uuid().parse(options['--revision']);
  if (!process.env.DATABASE_URL)
    throw new Error('Supply DATABASE_URL explicitly; no .env is loaded');
  const logger = new LoggerService();
  const database = new DbService(logger, {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 1 },
  });
  try {
    const recovery = new SyncUploadRecovery(
      new SyncRepository(database, logger),
      new StoreService(logger),
    );
    const inspected = await recovery.inspect(account, revision);
    if (!options['--apply']) {
      console.log(
        JSON.stringify({ mode: 'inspect', storage, ...inspected }, null, 2),
      );
      return;
    }
    await recovery.retire(account, revision, {
      writerDrainConfirmed: options['--writer-drain-confirmed'] === true,
      reason: String(options['--reason'] ?? ''),
    });
    console.log(
      JSON.stringify({ mode: 'retired', storage, account, revision }),
    );
  } finally {
    await database.onModuleDestroy();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Sync recovery refused',
  );
  process.exitCode = 1;
});
