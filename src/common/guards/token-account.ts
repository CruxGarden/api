import { ServiceUnavailableException } from '@nestjs/common';
import { DbService } from '../services/db.service';

/** A signed token cannot keep a closed account alive until JWT expiry. */
export async function activeTokenAccount(
  db: DbService | undefined,
  payload: unknown,
): Promise<boolean> {
  if (!db)
    throw new ServiceUnavailableException(
      'Account authentication is unavailable',
    );
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('id' in payload) ||
    typeof payload.id !== 'string'
  )
    return false;
  return !!(await db
    .query()
    .from('accounts')
    .where({ id: payload.id })
    .whereNull('deleted')
    .first('id'));
}
