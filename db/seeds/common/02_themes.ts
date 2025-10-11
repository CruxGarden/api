import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const themes = [
        {
            id: 'a1b2c3d4-e5f6-4890-ab12-cd34ef567890',
            key: 'E8ZWg1SUjER',
            author_id: authorId,
            title: 'Midnight Shadow',
            description: 'A sleek dark theme with deep blacks and subtle accents, perfect for focused work in low-light environments',
            primary_color: '#0f0f0f',      // Deep black
            secondary_color: '#1a1a1a',    // Dark gray
            tertiary_color: '#333333',     // Medium gray
            quaternary_color: '#4a90e2',   // Accent blue
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'b2c3d4e5-f6a7-4801-bc23-de45ab678901',
            key: 'kLSrWqfLP6D',
            author_id: authorId,
            title: 'Arctic Breeze',
            description: 'A clean and minimalist light theme with crisp whites and soft grays for maximum readability',
            primary_color: '#ffffff',      // Pure white
            secondary_color: '#f8f9fa',    // Off-white
            tertiary_color: '#e9ecef',     // Light gray
            quaternary_color: '#6c757d',   // Medium gray
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'c3d4e5f6-a7b8-4012-cd34-ef56ab789012',
            key: 'l0mkAWPe3ft',
            author_id: authorId,
            title: 'Corporate Elite',
            description: 'A professional business theme with navy blues and sophisticated grays, ideal for presentations and formal documents',
            primary_color: '#1e3a8a',      // Navy blue
            secondary_color: '#3730a3',    // Royal blue
            tertiary_color: '#64748b',     // Steel gray
            quaternary_color: '#f1f5f9',   // Light background
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'd4e5f6a7-b8c9-4123-de45-ab67cd890123',
            key: 'lIj109_OuUW',
            author_id: authorId,
            title: 'Sunset Canvas',
            description: 'A vibrant creative theme inspired by golden hour sunsets, featuring warm oranges and artistic gradients',
            primary_color: '#ea580c',      // Bright orange
            secondary_color: '#f97316',    // Orange
            tertiary_color: '#fed7aa',     // Peach
            quaternary_color: '#fef3c7',   // Light yellow
            created: new Date(),
            updated: new Date(),
        },
        {
            id: 'e5f6a7b8-c9d0-4234-ef56-ab78cd901234',
            key: 'WZKoUfYgI6l',
            author_id: authorId,
            title: 'Neon Glitch',
            description: 'A wild cyberpunk theme with electric colors and futuristic vibes, for those who dare to be different',
            primary_color: '#10b981',      // Electric green
            secondary_color: '#8b5cf6',    // Purple
            tertiary_color: '#f59e0b',     // Electric yellow
            quaternary_color: '#1f2937',   // Dark background
            created: new Date(),
            updated: new Date(),
        },
    ];

    // Check each theme and only insert if it doesn't exist
    for (const theme of themes) {
        const existing = await knex("themes")
            .where({ key: theme.key })
            .first();

        if (!existing) {
            await knex("themes").insert(theme);
        }
    }
};