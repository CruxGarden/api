import { Knex } from "knex";
import { KeyMaster } from "../../../src/common/services/key.master";
const keyMaster = new KeyMaster();

export async function seed(knex: Knex): Promise<void> {
    // Check if a primary home already exists
    const existingPrimaryHome = await knex("homes")
        .where({ primary: true })
        .whereNull('deleted')
        .first();

    // Only create if no primary home exists
    if (!existingPrimaryHome) {
        const primaryHome = {
            id: keyMaster.generateId(),
            key: keyMaster.generateKey(),
            name: 'Home',
            description: 'The home of this Crux Garden',
            primary: true,
            type: 'local',
            kind: 'default',
            meta: null,
            created: new Date(),
            updated: new Date(),
        };

        await knex("homes").insert(primaryHome);
    }
}
