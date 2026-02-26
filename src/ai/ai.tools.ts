import Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'write_file',
    description:
      'Create or update a file in the workspace. Use this to write code, config, text, images, or any file content. For binary files (images, PDFs, etc.), set encoding to "base64" and provide base64-encoded content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path (e.g., src/index.ts, README.md, logo.png)',
        },
        content: {
          type: 'string',
          description:
            'Full file content. For text files, provide raw text. For binary files, provide base64-encoded content.',
        },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description:
            'Content encoding. Use "utf-8" (default) for text files, "base64" for binary files (images, PDFs, etc.).',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List all files in the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_palette',
    description:
      'Get the current workspace palette. Returns all 26 properties: colors, glass blur, mesh background, border radius, and fonts. Call this before making changes so you know what you\'re working with.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_palette',
    description:
      'Customize the workspace appearance in real-time. Provide any subset of keys. The UI updates instantly. ' +
      'COLORS: bg, surface (with opacity), surfaceSolid, panel (with opacity), text, textMuted, border, accent, accentMuted, error, errorMuted, mesh1-mesh4 (gradient colors). ' +
      'GLASS: glassBlur (backdrop blur, e.g. "12px", "0px" for flat), panelBlur (heavier blur for cards). ' +
      'MESH BACKGROUND: meshOpacity ("0" hides it, "1" full), meshBlur (blob softness), meshSpeed (multiplier: "0.3" slow, "3" fast), meshScale (blob size: "0.5" small, "2" huge). ' +
      'SHAPE: radius (panels/cards, "0" sharp, "1rem" round), radiusSm (buttons/inputs). ' +
      'FONTS: fontDisplay (headings), fontBody (body text), fontMono (code). Use CSS font stacks like "Georgia, serif" or "system-ui, sans-serif".',
    input_schema: {
      type: 'object' as const,
      properties: {
        // Colors
        bg: { type: 'string', description: 'Background color (e.g., "#0b0d0c")' },
        surface: { type: 'string', description: 'Surface/panel background (e.g., "rgba(18, 21, 19, 0.7)")' },
        surfaceSolid: { type: 'string', description: 'Opaque surface color' },
        panel: { type: 'string', description: 'Glass panel background (e.g., "rgba(20, 24, 22, 0.6)")' },
        text: { type: 'string', description: 'Primary text color' },
        textMuted: { type: 'string', description: 'Secondary/muted text color' },
        border: { type: 'string', description: 'Border color (e.g., "rgba(82, 96, 86, 0.18)")' },
        accent: { type: 'string', description: 'Accent color for interactive elements' },
        accentMuted: { type: 'string', description: 'Accent background (e.g., "rgba(125, 179, 163, 0.12)")' },
        error: { type: 'string', description: 'Error text color' },
        errorMuted: { type: 'string', description: 'Error background color' },
        mesh1: { type: 'string', description: 'Mesh gradient color 1' },
        mesh2: { type: 'string', description: 'Mesh gradient color 2' },
        mesh3: { type: 'string', description: 'Mesh gradient color 3' },
        mesh4: { type: 'string', description: 'Mesh gradient color 4' },
        // Glass
        glassBlur: { type: 'string', description: 'Backdrop blur for panels (e.g., "12px", "0px" for no blur, "24px" heavy)' },
        panelBlur: { type: 'string', description: 'Stronger blur for cards/panels (e.g., "16px")' },
        // Mesh
        meshOpacity: { type: 'string', description: 'Mesh blob opacity ("0" hidden, "0.6" default, "1" full)' },
        meshBlur: { type: 'string', description: 'Blob softness ("60px" sharp, "120px" default, "200px" very soft)' },
        meshSpeed: { type: 'string', description: 'Animation speed ("0.3" slow, "1" normal, "3" fast)' },
        meshScale: { type: 'string', description: 'Blob size ("0.5" small, "1" default, "2" huge)' },
        // Shape
        radius: { type: 'string', description: 'Border radius for panels/cards ("0" sharp, "0.5rem" default, "1rem" round)' },
        radiusSm: { type: 'string', description: 'Border radius for buttons/inputs ("0" sharp, "0.375rem" default, "1rem" pill)' },
        // Fonts
        fontDisplay: { type: 'string', description: 'Heading font stack (e.g., "Georgia, serif", "system-ui, sans-serif")' },
        fontBody: { type: 'string', description: 'Body text font stack (e.g., "Inter, sans-serif")' },
        fontMono: { type: 'string', description: 'Code font stack (e.g., "Fira Code, monospace")' },
      },
      required: [],
    },
  },
];
