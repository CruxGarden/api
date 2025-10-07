import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    const keeperAccount = {
        id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
        key: 'TKSoWfISLG_',
        email: 'keeper@crux.garden',
        role: 'keeper'
    };

    // Check if keeper account already exists
    const existing = await knex("accounts")
        .where({ email: keeperAccount.email })
        .first();

    // Only insert if not found
    if (!existing) {
        await knex("accounts").insert(keeperAccount);
    }
};
