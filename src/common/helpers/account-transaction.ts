import { NotFoundException } from '@nestjs/common';
import { DbService } from '../services/db.service';

/** Serialize short account-owned state changes, including nested operations.
 * External bulk uploads run before admission; notifications run after commit.
 */
export function accountTransaction<T>(
  database: DbService,
  accountId: string,
  work: (closed: boolean) => Promise<T>,
  scope: 'live' | 'retained' = 'live',
): Promise<T> {
  return database.transaction(async () => {
    const db = database.query();
    let account = db('accounts').where({ id: accountId });
    // Only webhook receipts may inspect a retained, soft-deleted owner. The
    // callback must prove closure and billing identities before acknowledging it.
    if (scope === 'live') account = account.whereNull('deleted');
    if (db.client.dialect !== 'sqlite3') {
      await db.raw("SET LOCAL lock_timeout = '5s'");
      await db.raw("SET LOCAL statement_timeout = '15s'");
      account = account.forUpdate();
    }
    const row = await account.first('id', 'deleted');
    if (!row) throw new NotFoundException('Account not found');
    return work(row.deleted !== null);
  });
}
