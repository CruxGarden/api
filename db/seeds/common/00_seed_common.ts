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

    // ===== STEP 2: Create Keeper Account =====
    const keeperAccount = {
        id: accountId,
        key: generateKey(),
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

    // ===== STEP 3: Create Keeper Author (without root_id initially) =====
    const existingAuthor = await knex("authors")
        .where({ id: authorId })
        .first();

    if (!existingAuthor) {
        const keeperAuthor = {
            id: authorId,
            key: generateKey(),
            username: 'keeper',
            display_name: 'The Keeper',
            bio: 'The Keeper of the Crux Garden',
            root_id: null, // Set to null initially to break circular dependency
            account_id: accountId,
            home_id: primaryHome.id,
            created: new Date(),
            updated: new Date(),
        };

        await knex("authors").insert(keeperAuthor);
    }

    // ===== STEP 4: Create Root Crux for Keeper =====
    const existingRootCrux = await knex("cruxes")
        .where({ id: rootCruxId })
        .first();

    if (!existingRootCrux) {
        const keeperRootCrux = {
            id: rootCruxId,
            key: 'aZ7sNeIrmEO2QG_Z',
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

    // ===== STEP 5: Update Author with root_id =====
    // Now that the root crux exists, update the author to reference it
    if (!existingAuthor) {
        await knex("authors")
            .where({ id: authorId })
            .update({ root_id: rootCruxId });
    }

    // ===== STEP 6: Create Themes =====
    const themes = [
        {
            id: generateId(),
            key: 'default', // Fixed key for default theme
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Default Theme',
            description: 'Built-in default theme for Crux Garden',
            type: 'default',
            kind: 'auto',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#2a3d2c', secondary: '#426046', tertiary: '#58825e', quaternary: '#73a079' },
                    dark: { primary: '#2a3d2c', secondary: '#426046', tertiary: '#58825e', quaternary: '#73a079' }
                },
                bloom: {
                    light: {
                        primary: { solid: '#0a594d' },
                        secondary: { solid: '#127566' },
                        tertiary: { solid: '#1a9179' },
                        quaternary: { solid: '#2eb09a' },
                        borderColor: '#4dd9b8',
                        borderWidth: '9',
                        shadowEnabled: false,
                        shadowColor: '#000000',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '0',
                        shadowOpacity: '0'
                    },
                    dark: {
                        primary: { solid: '#02241c' },
                        secondary: { solid: '#02382b' },
                        tertiary: { solid: '#044e3d' },
                        quaternary: { solid: '#047057' },
                        borderColor: '#4dd9b8',
                        borderWidth: '9',
                        shadowEnabled: false,
                        shadowColor: '#000000',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '0',
                        shadowOpacity: '0'
                    }
                },
                content: {
                    light: { backgroundColor: '#f5f7f8', panelColor: '#ffffff', textColor: '#000000', borderColor: '#cccccc', borderWidth: '1', borderRadius: '12', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#b3d9ff' },
                    dark: { backgroundColor: '#0f1214', panelColor: '#1a1f24', textColor: '#e8eef2', borderColor: '#333333', borderWidth: '1', borderRadius: '12', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#4a9eff' }
                },
                controls: {
                    light: { buttonBackground: { solid: '#4dd9b8' }, buttonTextColor: '#0f1214', buttonBorderColor: '#4dd9b8', buttonBorderWidth: '1', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#2563eb', linkUnderlineStyle: 'underline' },
                    dark: { buttonBackground: { solid: '#4dd9b8' }, buttonTextColor: '#0f1214', buttonBorderColor: '#4dd9b8', buttonBorderWidth: '1', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#60a5fa', linkUnderlineStyle: 'underline' }
                }
            },
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Twilight Garden',
            description: 'A balanced theme with cool dark tones and electric teal accents, perfect for extended coding sessions',
            type: 'nature',
            kind: 'auto',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#e8eef2', secondary: '#c2cad2', tertiary: '#8b9199', quaternary: '#4dd9b8' },
                    dark: { primary: '#4dd9b8', secondary: '#6de8ca', tertiary: '#3dbfa0', quaternary: '#357d6a' }
                },
                bloom: {
                    light: {
                        primary: { solid: '#4dd9b8' },
                        secondary: { solid: '#6de8ca' },
                        tertiary: { solid: '#3dbfa0' },
                        quaternary: { solid: '#357d6a' },
                        borderWidth: '0',
                        shadowEnabled: false,
                        shadowColor: '#000000',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '0',
                        shadowOpacity: '0'
                    },
                    dark: {
                        primary: { solid: '#4dd9b8' },
                        secondary: { solid: '#6de8ca' },
                        tertiary: { solid: '#3dbfa0' },
                        quaternary: { solid: '#357d6a' },
                        borderWidth: '0',
                        shadowEnabled: false,
                        shadowColor: '#000000',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '0',
                        shadowOpacity: '0'
                    }
                },
                content: {
                    light: { backgroundColor: '#ffffff', panelColor: '#f8f9fa', textColor: '#1a1d21', borderColor: '#e9ecef', borderWidth: '1', borderRadius: '8', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#b3d9ff' },
                    dark: { backgroundColor: '#0f1214', panelColor: '#1a1d21', textColor: '#e8eef2', borderColor: '#2f3338', borderWidth: '1', borderRadius: '8', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#4a9eff' }
                },
                controls: {
                    light: { buttonBackground: { solid: '#4dd9b8' }, buttonTextColor: '#0f1214', buttonBorderColor: '#4dd9b8', buttonBorderWidth: '0', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#2563eb', linkUnderlineStyle: 'underline' },
                    dark: { buttonBackground: { solid: '#4dd9b8' }, buttonTextColor: '#0f1214', buttonBorderColor: '#4dd9b8', buttonBorderWidth: '0', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#60a5fa', linkUnderlineStyle: 'underline' }
                }
            },
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Ocean Depths',
            description: 'Deep blue theme inspired by mysterious ocean waters with bioluminescent accents',
            type: 'nature',
            kind: 'dark',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#e0f2fe', secondary: '#bae6fd', tertiary: '#7dd3fc', quaternary: '#0ea5e9' },
                    dark: { primary: '#0c4a6e', secondary: '#075985', tertiary: '#0369a1', quaternary: '#0ea5e9' }
                },
                bloom: {
                    light: {
                        primary: { solid: '#0ea5e9' },
                        secondary: { solid: '#38bdf8' },
                        tertiary: { solid: '#7dd3fc' },
                        quaternary: { solid: '#bae6fd' },
                        borderWidth: '2',
                        borderColor: '#0284c7',
                        shadowEnabled: true,
                        shadowColor: '#0ea5e9',
                        shadowOffsetX: '0',
                        shadowOffsetY: '4',
                        shadowBlurRadius: '12',
                        shadowOpacity: '0.3'
                    },
                    dark: {
                        primary: { gradient: { id: 'ocean-depths-primary', angle: 135, stops: [{ color: '#0c4a6e', offset: "0%" }, { color: '#075985', offset: "100%" }] } },
                        secondary: { gradient: { id: 'ocean-depths-secondary', angle: 135, stops: [{ color: '#075985', offset: "0%" }, { color: '#0369a1', offset: "100%" }] } },
                        tertiary: { gradient: { id: 'ocean-depths-tertiary', angle: 135, stops: [{ color: '#0369a1', offset: "0%" }, { color: '#0ea5e9', offset: "100%" }] } },
                        quaternary: { solid: '#0ea5e9' },
                        borderWidth: '2',
                        borderColor: '#0284c7',
                        shadowEnabled: true,
                        shadowColor: '#0ea5e9',
                        shadowOffsetX: '0',
                        shadowOffsetY: '4',
                        shadowBlurRadius: '16',
                        shadowOpacity: '0.4'
                    }
                },
                content: {
                    light: { backgroundColor: '#f0f9ff', panelColor: '#e0f2fe', textColor: '#0c4a6e', borderColor: '#bae6fd', borderWidth: '1', borderRadius: '12', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#bae6fd' },
                    dark: { backgroundColor: '#020617', panelColor: '#0c1929', textColor: '#e0f2fe', borderColor: '#1e3a5f', borderWidth: '1', borderRadius: '12', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#38bdf8' }
                },
                controls: {
                    light: { buttonBackground: { solid: '#0ea5e9' }, buttonTextColor: '#ffffff', buttonBorderColor: '#0284c7', buttonBorderWidth: '2', buttonBorderStyle: 'solid', buttonBorderRadius: '8', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#0369a1', linkUnderlineStyle: 'underline' },
                    dark: { buttonBackground: { gradient: { id: 'ocean-depths-button', angle: 135, stops: [{ color: '#0369a1', offset: "0%" }, { color: '#0ea5e9', offset: "100%" }] } }, buttonTextColor: '#ffffff', buttonBorderColor: '#0284c7', buttonBorderWidth: '0', buttonBorderStyle: 'solid', buttonBorderRadius: '8', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#38bdf8', linkUnderlineStyle: 'underline' }
                }
            },
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Sunset Canvas',
            description: 'Warm gradient theme inspired by golden hour with artistic amber and coral tones',
            type: 'creative',
            kind: 'light',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#ea580c', secondary: '#f97316', tertiary: '#fb923c', quaternary: '#fdba74' },
                    dark: { primary: '#7c2d12', secondary: '#9a3412', tertiary: '#c2410c', quaternary: '#ea580c' }
                },
                bloom: {
                    light: {
                        primary: { gradient: { id: 'sunset-canvas-primary-light', angle: 45, stops: [{ color: '#f97316', offset: "0%" }, { color: '#fb923c', offset: "50%" }, { color: '#fbbf24', offset: "100%" }] } },
                        secondary: { gradient: { id: 'sunset-canvas-secondary-light', angle: 135, stops: [{ color: '#fb923c', offset: "0%" }, { color: '#fbbf24', offset: "100%" }] } },
                        tertiary: { gradient: { id: 'sunset-canvas-tertiary-light', angle: 225, stops: [{ color: '#fbbf24', offset: "0%" }, { color: '#fcd34d', offset: "100%" }] } },
                        quaternary: { solid: '#fcd34d' },
                        borderWidth: '0',
                        shadowEnabled: true,
                        shadowColor: '#f97316',
                        shadowOffsetX: '0',
                        shadowOffsetY: '2',
                        shadowBlurRadius: '8',
                        shadowOpacity: '0.2'
                    },
                    dark: {
                        primary: { gradient: { id: 'sunset-canvas-primary-dark', angle: 45, stops: [{ color: '#c2410c', offset: "0%" }, { color: '#ea580c', offset: "100%" }] } },
                        secondary: { solid: '#ea580c' },
                        tertiary: { solid: '#f97316' },
                        quaternary: { solid: '#fb923c' },
                        borderWidth: '0',
                        shadowEnabled: false
                    }
                },
                content: {
                    light: { backgroundColor: '#fffbeb', panelColor: '#fef3c7', textColor: '#78350f', borderColor: '#fde68a', borderWidth: '1', borderRadius: '16', borderStyle: 'solid', font: 'serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#fde68a' },
                    dark: { backgroundColor: '#1c0f05', panelColor: '#2d1a0a', textColor: '#fef3c7', borderColor: '#78350f', borderWidth: '1', borderRadius: '16', borderStyle: 'solid', font: 'serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#fb923c' }
                },
                controls: {
                    light: { buttonBackground: { gradient: { id: 'sunset-canvas-button-light', angle: 135, stops: [{ color: '#f97316', offset: "0%" }, { color: '#fbbf24', offset: "100%" }] } }, buttonTextColor: '#ffffff', buttonBorderColor: '#ea580c', buttonBorderWidth: '0', buttonBorderStyle: 'solid', buttonBorderRadius: '24', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#c2410c', linkUnderlineStyle: 'none' },
                    dark: { buttonBackground: { solid: '#ea580c' }, buttonTextColor: '#ffffff', buttonBorderColor: '#c2410c', buttonBorderWidth: '2', buttonBorderStyle: 'solid', buttonBorderRadius: '24', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#fb923c', linkUnderlineStyle: 'none' }
                }
            },
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Forest Whisper',
            description: 'Organic green theme with natural earth tones and soft sage accents',
            type: 'nature',
            kind: 'auto',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#14532d', secondary: '#166534', tertiary: '#22c55e', quaternary: '#86efac' },
                    dark: { primary: '#86efac', secondary: '#4ade80', tertiary: '#22c55e', quaternary: '#166534' }
                },
                bloom: {
                    light: {
                        primary: { solid: '#22c55e' },
                        secondary: { solid: '#4ade80' },
                        tertiary: { solid: '#86efac' },
                        quaternary: { solid: '#bbf7d0' },
                        borderWidth: '2',
                        borderColor: '#16a34a',
                        shadowEnabled: false
                    },
                    dark: {
                        primary: { solid: '#22c55e' },
                        secondary: { solid: '#4ade80' },
                        tertiary: { solid: '#86efac' },
                        quaternary: { solid: '#bbf7d0' },
                        borderWidth: '2',
                        borderColor: '#16a34a',
                        shadowEnabled: true,
                        shadowColor: '#22c55e',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '16',
                        shadowOpacity: '0.3'
                    }
                },
                content: {
                    light: { backgroundColor: '#f7fee7', panelColor: '#ecfccb', textColor: '#14532d', borderColor: '#d9f99d', borderWidth: '1', borderRadius: '8', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: true, panelShadowColor: '#22c55e', panelShadowOffsetX: '0', panelShadowOffsetY: '2', panelShadowBlurRadius: '4', panelShadowOpacity: '0.05', selectionColor: '#d9f99d' },
                    dark: { backgroundColor: '#0a1f12', panelColor: '#14291a', textColor: '#dcfce7', borderColor: '#166534', borderWidth: '1', borderRadius: '8', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#4ade80' }
                },
                controls: {
                    light: { buttonBackground: { solid: '#22c55e' }, buttonTextColor: '#ffffff', buttonBorderColor: '#16a34a', buttonBorderWidth: '0', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#15803d', linkUnderlineStyle: 'underline' },
                    dark: { buttonBackground: { solid: '#22c55e' }, buttonTextColor: '#052e16', buttonBorderColor: '#16a34a', buttonBorderWidth: '0', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#86efac', linkUnderlineStyle: 'underline' }
                }
            },
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Monochrome Terminal',
            description: 'Classic terminal-inspired theme with crisp monospace typography and high contrast',
            type: 'technical',
            kind: 'dark',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#000000', secondary: '#1a1a1a', tertiary: '#333333', quaternary: '#00ff00' },
                    dark: { primary: '#000000', secondary: '#0d0d0d', tertiary: '#1a1a1a', quaternary: '#00ff00' }
                },
                bloom: {
                    light: {
                        primary: { solid: '#00ff00' },
                        secondary: { solid: '#00cc00' },
                        tertiary: { solid: '#009900' },
                        quaternary: { solid: '#006600' },
                        borderWidth: '1',
                        borderColor: '#00ff00',
                        shadowEnabled: false
                    },
                    dark: {
                        primary: { solid: '#00ff00' },
                        secondary: { solid: '#00cc00' },
                        tertiary: { solid: '#009900' },
                        quaternary: { solid: '#006600' },
                        borderWidth: '1',
                        borderColor: '#00ff00',
                        shadowEnabled: true,
                        shadowColor: '#00ff00',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '8',
                        shadowOpacity: '0.5'
                    }
                },
                content: {
                    light: { backgroundColor: '#f5f5f5', panelColor: '#ffffff', textColor: '#000000', borderColor: '#333333', borderWidth: '1', borderRadius: '0', borderStyle: 'solid', font: 'monospace', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#cccccc' },
                    dark: { backgroundColor: '#000000', panelColor: '#0d0d0d', textColor: '#00ff00', borderColor: '#00ff00', borderWidth: '1', borderRadius: '0', borderStyle: 'solid', font: 'monospace', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#006600' }
                },
                controls: {
                    light: { buttonBackground: { solid: '#000000' }, buttonTextColor: '#00ff00', buttonBorderColor: '#000000', buttonBorderWidth: '1', buttonBorderStyle: 'solid', buttonBorderRadius: '0', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#0000ff', linkUnderlineStyle: 'always' },
                    dark: { buttonBackground: { solid: '#00ff00' }, buttonTextColor: '#000000', buttonBorderColor: '#00ff00', buttonBorderWidth: '1', buttonBorderStyle: 'solid', buttonBorderRadius: '0', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#00ff00', linkUnderlineStyle: 'always' }
                }
            },
            created: new Date(),
            updated: new Date(),
        },
        {
            id: generateId(),
            key: generateKey(),
            author_id: authorId,
            home_id: primaryHome.id,
            title: 'Nascent Web',
            description: 'An unadorned, web 1.0 style',
            type: 'custom',
            kind: 'auto',
            system: true,
            meta: {
                palette: {
                    light: { primary: '#ffffff', secondary: '#ffffff', tertiary: '#ffffff', quaternary: '#ffffff' },
                    dark: { primary: '#000000', secondary: '#000000', tertiary: '#000000', quaternary: '#000000' }
                },
                bloom: {
                    light: {
                        primary: { solid: '#ffffff' },
                        secondary: { solid: '#ffffff' },
                        tertiary: { solid: '#ffffff' },
                        quaternary: { solid: '#ffffff' },
                        borderColor: '#000000',
                        borderWidth: '20',
                        shadowEnabled: false,
                        shadowColor: '#000000',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '0',
                        shadowOpacity: '0'
                    },
                    dark: {
                        primary: { solid: '#000000' },
                        secondary: { solid: '#000000' },
                        tertiary: { solid: '#000000' },
                        quaternary: { solid: '#000000' },
                        borderColor: '#ffffff',
                        borderWidth: '20',
                        shadowEnabled: false,
                        shadowColor: '#000000',
                        shadowOffsetX: '0',
                        shadowOffsetY: '0',
                        shadowBlurRadius: '0',
                        shadowOpacity: '0'
                    }
                },
                content: {
                    light: { backgroundColor: '#ffffff', panelColor: '#ffffff', textColor: '#000000', borderColor: '#000000', borderWidth: '0', borderRadius: '0', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#b3d9ff' },
                    dark: { backgroundColor: '#000000', panelColor: '#000000', textColor: '#ffffff', borderColor: '#ffffff', borderWidth: '0', borderRadius: '0', borderStyle: 'solid', font: 'sans-serif', panelShadowEnabled: false, panelShadowColor: '#000000', panelShadowOffsetX: '0', panelShadowOffsetY: '0', panelShadowBlurRadius: '0', panelShadowOpacity: '0', selectionColor: '#4a9eff' }
                },
                controls: {
                    light: { buttonBackground: { solid: '#ebeaea' }, buttonTextColor: '#000000', buttonBorderColor: '#8a8a8a', buttonBorderWidth: '2', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#0000ee', linkUnderlineStyle: 'always' },
                    dark: { buttonBackground: { solid: '#ebeaea' }, buttonTextColor: '#000000', buttonBorderColor: '#8a8a8a', buttonBorderWidth: '2', buttonBorderStyle: 'solid', buttonBorderRadius: '6', buttonShadowEnabled: false, buttonShadowColor: '#000000', buttonShadowOffsetX: '0', buttonShadowOffsetY: '0', buttonShadowBlurRadius: '0', buttonShadowOpacity: '0', linkColor: '#00ffff', linkUnderlineStyle: 'always' }
                }
            },
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
