import { Knex } from "knex";
import { KeyMaster } from "../../../src/common/services/key.master";
const keyMaster = new KeyMaster();

export async function seed(knex: Knex): Promise<void> {
    const accountId = 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    // Look up the primary home
    const primaryHome = await knex("homes")
        .where({ primary: true })
        .whereNull('deleted')
        .first();

    if (!primaryHome) {
        throw new Error('Primary home not found. Run 00_home.ts seed first.');
    }

    const keeperAccount = {
        id: accountId,
        key: keyMaster.generateKey(),
        email: 'keeper@crux.garden',
        role: 'keeper',
        home_id: primaryHome.id
    };

    const keeperAuthor = {
        id: authorId,
        key: keyMaster.generateKey(),
        username: 'keeper',
        display_name: 'The Keeper',
        bio: 'The Keeper of the Crux Garden',
        account_id: accountId,
        home_id: primaryHome.id,
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
