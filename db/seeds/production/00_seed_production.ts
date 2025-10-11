import { Knex } from "knex";
import { randomUUID } from 'crypto';
import ShortUniqueId from 'short-unique-id';

// Inline key generation utilities
const keyGenerator = new ShortUniqueId({
    length: 16,
    dictionary: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
});

const generateId = () => randomUUID();
const generateKey = () => keyGenerator.rnd();

export async function seed(knex: Knex): Promise<void> {
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    // Look up the primary home
    const primaryHome = await knex("homes")
        .where({ primary: true })
        .whereNull('deleted')
        .first();

    if (!primaryHome) {
        throw new Error('Primary home not found. Run common seeds first.');
    }

    const systemCruxes = [
        {
            id: generateId(),
            key: generateKey(),
            slug: 'welcome-to-crux-garden',
            title: 'Welcome to Crux Garden',
            description: 'Your journey into interconnected thinking begins here.',
            data: 'Welcome to Crux Garden! This is a production system message that helps new users get started.',
            type: 'system',
            status: 'frozen',
            visibility: 'public',
            author_id: authorId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            slug: 'terms-of-service',
            title: 'Terms of Service',
            description: 'Terms and conditions for using Crux Garden.',
            data: 'This would contain the actual terms of service content for your production deployment.',
            type: 'system',
            status: 'frozen',
            visibility: 'public',
            author_id: authorId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        },
    ];

    // Check each crux and only insert if it doesn't exist
    for (const crux of systemCruxes) {
        const existing = await knex("cruxes")
            .where({ slug: crux.slug })
            .first();

        if (!existing) {
            await knex("cruxes").insert(crux);
        }
    }
}
