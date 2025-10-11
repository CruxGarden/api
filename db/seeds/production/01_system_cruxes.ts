import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const systemCruxes = [
        {
            id: 'c4d5e6f7-a8b9-4012-d345-ef6789012345',
            key: 'system_welcome',
            slug: 'welcome-to-crux-garden',
            title: 'Welcome to Crux Garden',
            description: 'Your journey into interconnected thinking begins here.',
            data: 'Welcome to Crux Garden! This is a production system message that helps new users get started.',
            type: 'system',
            status: 'frozen',
            visibility: 'public',
            author_id: authorId,
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'd5e6f7a8-b9c0-4123-e456-f78901234567',
            key: 'system_terms',
            slug: 'terms-of-service',
            title: 'Terms of Service',
            description: 'Terms and conditions for using Crux Garden.',
            data: 'This would contain the actual terms of service content for your production deployment.',
            type: 'system',
            status: 'frozen',
            visibility: 'public',
            author_id: authorId,
            created: new Date(),
            updated: new Date(),
        },
    ];

    // Check each crux and only insert if it doesn't exist
    for (const crux of systemCruxes) {
        const existing = await knex("cruxes")
            .where({ key: crux.key })
            .first();

        if (!existing) {
            await knex("cruxes").insert(crux);
        }
    }
}
