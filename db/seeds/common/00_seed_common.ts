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
    const accountId = 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const authorId = 'e7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';
    const rootCruxId = 'f7f5c645-6b4e-4c3b-a5cb-3fd81c652b96';

    // ===== STEP 1: Create Primary Home =====
    const existingPrimaryHome = await knex("homes")
        .where({ primary: true })
        .whereNull('deleted')
        .first();

    let primaryHome = existingPrimaryHome;

    if (!existingPrimaryHome) {
        const newHome = {
            id: generateId(),
            key: generateKey(),
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

    // ===== STEP 2: Create Root Crux for Keeper =====
    const existingRootCrux = await knex("cruxes")
        .where({ id: rootCruxId })
        .first();

    if (!existingRootCrux) {
        const keeperRootCrux = {
            id: rootCruxId,
            key: generateKey(),
            slug: 'keeper-root',
            title: 'Welcome to Crux Garden!',
            data: '## What are you thinking today?',
            type: 'markdown',
            status: 'living',
            visibility: 'unlisted',
            author_id: authorId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        };

        await knex("cruxes").insert(keeperRootCrux);
    }

    // ===== STEP 3: Create Keeper Account & Author =====
    const keeperAccount = {
        id: accountId,
        key: generateKey(),
        email: 'keeper@crux.garden',
        role: 'keeper',
        home_id: primaryHome.id
    };

    const keeperAuthor = {
        id: authorId,
        key: generateKey(),
        username: 'keeper',
        display_name: 'The Keeper',
        bio: 'The Keeper of the Crux Garden',
        root_id: rootCruxId,
        account_id: accountId,
        home_id: primaryHome.id,
        created: new Date(),
        updated: new Date(),
    };

    // Check if keeper account already exists
    const existingAccount = await knex("accounts")
        .where({ email: keeperAccount.email })
        .first();

    if (!existingAccount) {
        await knex("accounts").insert(keeperAccount);
    }

    // Check if keeper author already exists
    const existingAuthor = await knex("authors")
        .where({ id: authorId })
        .first();

    if (!existingAuthor) {
        await knex("authors").insert(keeperAuthor);
    }

    // ===== STEP 3: Create Themes =====
    const themes = [
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Midnight Shadow',
            description: 'A sleek dark theme with deep blacks and subtle accents, perfect for focused work in low-light environments',
            primary_color: '#0f0f0f',
            secondary_color: '#1a1a1a',
            tertiary_color: '#333333',
            quaternary_color: '#4a90e2',
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Arctic Breeze',
            description: 'A clean and minimalist light theme with crisp whites and soft grays for maximum readability',
            primary_color: '#ffffff',
            secondary_color: '#f8f9fa',
            tertiary_color: '#e9ecef',
            quaternary_color: '#6c757d',
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Corporate Elite',
            description: 'A professional business theme with navy blues and sophisticated grays, ideal for presentations and formal documents',
            primary_color: '#1e3a8a',
            secondary_color: '#3730a3',
            tertiary_color: '#64748b',
            quaternary_color: '#f1f5f9',
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Sunset Canvas',
            description: 'A vibrant creative theme inspired by golden hour sunsets, featuring warm oranges and artistic gradients',
            primary_color: '#ea580c',
            secondary_color: '#f97316',
            tertiary_color: '#fed7aa',
            quaternary_color: '#fef3c7',
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Neon Glitch',
            description: 'A wild cyberpunk theme with electric colors and futuristic vibes, for those who dare to be different',
            primary_color: '#10b981',
            secondary_color: '#8b5cf6',
            tertiary_color: '#f59e0b',
            quaternary_color: '#1f2937',
            created: new Date(),
            updated: new Date(),
        },
    ];

    for (const theme of themes) {
        const existing = await knex("themes")
            .where({ title: theme.title })
            .first();

        if (!existing) {
            await knex("themes").insert(theme);
        }
    }
}
