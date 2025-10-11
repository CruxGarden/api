import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    const accountId = 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    const keeperAccount = {
        id: accountId,
        key: 'TKSoWfISLG_',
        email: 'keeper@crux.garden',
        role: 'keeper'
    };

    const keeperAuthor = {
        id: authorId,
        key: 'EKSoWfISLG_',
        username: 'keeper',
        display_name: 'The Keeper',
        bio: 'The Keeper of the Crux Garden',
        account_id: accountId,
        created: new Date(),
        updated: new Date(),
    };

    // Check if keeper account already exists
    const existingAccount = await knex("accounts")
        .where({ email: keeperAccount.email })
        .first();

    // Only insert if not found
    if (!existingAccount) {
        await knex("accounts").insert(keeperAccount);
    }

    // Check if keeper author already exists
    const existingAuthor = await knex("authors")
        .where({ id: authorId })
        .first();

    // Only insert if not found
    if (!existingAuthor) {
        await knex("authors").insert(keeperAuthor);
    }
};
