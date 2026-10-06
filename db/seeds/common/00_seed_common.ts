import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { isEmail } from 'class-validator';
import {
  nurseryAccount,
  NURSERY_AUTHOR_ID,
} from '../../../src/common/guards/nursery-account';

/** A normal install creates only the Home. Privileged identities require explicit configuration. */
export async function seed(knex: Knex): Promise<void> {
  const nursery = nurseryAccount(); // Also refuses production demo authentication before any write.
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || 'keeper';
  if (email && !isEmail(email))
    throw new Error('BOOTSTRAP_ADMIN_EMAIL must be an email address');
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    throw new Error('BOOTSTRAP_ADMIN_USERNAME must be a valid username');
  if (nursery && email)
    throw new Error(
      'Choose Nursery demo identity or BOOTSTRAP_ADMIN_EMAIL, not both',
    );

  await knex.transaction(async (db) => {
    let home = await db('homes')
      .where({ primary: true })
      .whereNull('deleted')
      .first();
    if (!home) {
      home = {
        id: randomUUID(),
        name: 'Home',
        description: 'The home of this Crux Garden',
        primary: true,
        type: 'local',
        kind: 'default',
        meta: null,
        created: new Date(),
        updated: new Date(),
      };
      await db('homes').insert(home);
    }
    if (!nursery && !email) return;

    const accountEmail = nursery?.email ?? email;
    const role = nursery?.role ?? 'admin';
    let account = await db('accounts').where({ email: accountEmail }).first();
    if (account?.deleted) throw new Error('Cannot bootstrap a deleted account');
    if (nursery && account && account.id !== nursery.id) {
      throw new Error('The Nursery email belongs to a different account');
    }
    if (!account) {
      account = {
        id: nursery?.id ?? randomUUID(),
        email: accountEmail,
        role,
        home_id: home.id,
      };
      await db('accounts').insert(account);
    } else if (account.role !== role) {
      await db('accounts')
        .where({ id: account.id })
        .update({ role, updated: new Date() });
    }

    const author = await db('authors')
      .where({ account_id: account.id })
      .first();
    if (author?.deleted) throw new Error('Cannot bootstrap a deleted author');
    if (author) return;
    const authorUsername = nursery ? 'keeper' : username;
    if (await db('authors').where({ username: authorUsername }).first()) {
      throw new Error(
        'Bootstrap username already belongs to another account; choose BOOTSTRAP_ADMIN_USERNAME',
      );
    }
    await db('authors').insert({
      id: nursery ? NURSERY_AUTHOR_ID : randomUUID(),
      username: authorUsername,
      display_name: 'The Keeper',
      bio: 'The Keeper of the Crux Garden',
      root_id: null,
      account_id: account.id,
      home_id: home.id,
      created: new Date(),
      updated: new Date(),
    });
  });
}
