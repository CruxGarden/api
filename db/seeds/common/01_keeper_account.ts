import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    const keeperId = 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    const keeperAccount = {
        id: keeperId,
        key: 'TKSoWfISLG_',
        email: 'keeper@crux.garden',
        role: 'keeper'
    };

    const keeperAuthor = {
        id: keeperId,
        name: 'The Keeper',
        bio: 'Guardian of the Crux Garden',
        account_id: keeperId,
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
        .where({ id: keeperId })
        .first();

    // Only insert if not found
    if (!existingAuthor) {
        await knex("authors").insert(keeperAuthor);
    }
};
