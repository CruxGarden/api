import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    // Demo cruxes for the nursery environment
    const demoCruxes = [
        {
            id: 'f1a2b3c4-d5e6-4789-a012-bcdef3456789',
            key: 'demo_crux_001',
            slug: 'the-garden-metaphor',
            title: 'The Garden Metaphor',
            description: 'Ideas, like plants, need the right conditions to grow. A garden is not just a collection of seeds—it\'s an ecosystem where each element influences the others.',
            data: 'This is a foundational crux that explores how we think about knowledge management through the lens of cultivation rather than storage.',
            type: 'note',
            status: 'living',
            visibility: 'public',
            author_id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96', // The Keeper
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'a2b3c4d5-e6f7-4890-b123-cdef45678901',
            key: 'demo_crux_002',
            slug: 'interconnected-thinking',
            title: 'Interconnected Thinking',
            description: 'No idea exists in isolation. The connections between ideas are often more valuable than the ideas themselves.',
            data: 'This crux explores the power of linking concepts together and how dimensions (gates, gardens, growth, grafts) help us map the relationship landscape.',
            type: 'note',
            status: 'living',
            visibility: 'public',
            author_id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'b3c4d5e6-f7a8-4901-c234-def567890123',
            key: 'demo_crux_003',
            slug: 'digital-gardens-vs-notes',
            title: 'Digital Gardens vs Traditional Notes',
            description: 'Traditional note-taking is linear and hierarchical. Digital gardens embrace organic growth, emergence, and serendipity.',
            data: 'A comparison of different approaches to personal knowledge management, highlighting why the garden metaphor resonates with modern thinkers.',
            type: 'note',
            status: 'living',
            visibility: 'public',
            author_id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
            created: new Date(),
            updated: new Date(),
        },
    ];

    // Check each crux and only insert if it doesn't exist
    for (const crux of demoCruxes) {
        const existing = await knex("cruxes")
            .where({ key: crux.key })
            .first();

        if (!existing) {
            await knex("cruxes").insert(crux);
        }
    }
}
