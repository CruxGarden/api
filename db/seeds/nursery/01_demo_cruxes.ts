import { Knex } from "knex";
import { KeyMaster } from "../../../src/common/services/key.master";
const keyMaster = new KeyMaster();

export async function seed(knex: Knex): Promise<void> {
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    // Look up the primary home
    const primaryHome = await knex("homes")
        .where({ primary: true })
        .whereNull('deleted')
        .first();

    if (!primaryHome) {
        throw new Error('Primary home not found. Run 00_home.ts seed first.');
    }

    // Demo cruxes for the nursery environment
    const demoCruxes = [
        {
            id: keyMaster.generateId(),
            key: keyMaster.generateKey(),
            slug: 'the-garden-metaphor',
            title: 'The Garden Metaphor',
            description: 'Ideas, like plants, need the right conditions to grow. A garden is not just a collection of seeds—it\'s an ecosystem where each element influences the others.',
            data: 'This is a foundational crux that explores how we think about knowledge management through the lens of cultivation rather than storage.',
            type: 'note',
            status: 'living',
            visibility: 'public',
            author_id: authorId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        },
        {
            id: keyMaster.generateId(),
            key: keyMaster.generateKey(),
            slug: 'interconnected-thinking',
            title: 'Interconnected Thinking',
            description: 'No idea exists in isolation. The connections between ideas are often more valuable than the ideas themselves.',
            data: 'This crux explores the power of linking concepts together and how dimensions (gates, gardens, growth, grafts) help us map the relationship landscape.',
            type: 'note',
            status: 'living',
            visibility: 'public',
            author_id: authorId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        },
        {
            id: keyMaster.generateId(),
            key: keyMaster.generateKey(),
            slug: 'digital-gardens-vs-notes',
            title: 'Digital Gardens vs Traditional Notes',
            description: 'Traditional note-taking is linear and hierarchical. Digital gardens embrace organic growth, emergence, and serendipity.',
            data: 'A comparison of different approaches to personal knowledge management, highlighting why the garden metaphor resonates with modern thinkers.',
            type: 'note',
            status: 'living',
            visibility: 'public',
            author_id: authorId,
            home_id: primaryHome.id,
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
