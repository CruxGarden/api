import { Knex } from "knex";
import { randomUUID } from 'crypto';

const generateId = () => randomUUID();

export async function seed(knex: Knex): Promise<void> {
    const accountId = 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    // ===== STEP 1: Create Primary Home =====
    const existingPrimaryHome = await knex("homes")
        .where({ primary: true })
        .whereNull('deleted')
        .first();

    let primaryHome = existingPrimaryHome;

    if (!existingPrimaryHome) {
        const newHome = {
            id: generateId(),
            name: 'Home',
            description: 'The home of this Crux Garden',
            primary: true,
            type: 'local',
            kind: 'default',
            meta: null,
            created: new Date(),
            updated: new Date(),
        };

        await knex("homes").insert(newHome);
        primaryHome = newHome;
    }

    // ===== STEP 2: Create Keeper Account =====
    const keeperAccount = {
        id: accountId,
        email: 'keeper@crux.garden',
        role: 'keeper',
        home_id: primaryHome.id
    };

    // Check if keeper account already exists
    const existingAccount = await knex("accounts")
        .where({ email: keeperAccount.email })
        .first();

    if (!existingAccount) {
        await knex("accounts").insert(keeperAccount);
    }

    // ===== STEP 3: Create Keeper Author =====
    const existingAuthor = await knex("authors")
        .where({ id: authorId })
        .first();

    if (!existingAuthor) {
        const keeperAuthor = {
            id: authorId,
            username: 'keeper',
            display_name: 'The Keeper',
            bio: 'The Keeper of the Crux Garden',
            root_id: null,
            account_id: accountId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        };

        await knex("authors").insert(keeperAuthor);
    }
}
