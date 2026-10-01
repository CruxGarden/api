import { NotFoundException } from '@nestjs/common';
import { DbService } from '../common/services/db.service';

/** Shared by billing and its persistent simulation, including nested operations.
 * Lock the account, not the optional subscription row. Provider calls made while
 * holding this lock must have bounded timeouts; send notifications after commit.
 */
export function billingAccountTransaction<T>(
  database: DbService,
  accountId: string,
  work: () => Promise<T>,
): Promise<T> {
  return database.transaction(async () => {
    const db = database.query();
    let account = db('accounts').where({ id: accountId }).whereNull('deleted');
    if (db.client.dialect !== 'sqlite3') {
      await db.raw("SET LOCAL lock_timeout = '5s'");
      await db.raw("SET LOCAL statement_timeout = '15s'");
      account = account.forUpdate();
    }
    if (!(await account.first('id')))
      throw new NotFoundException('Account not found');
    return work();
  });
}
