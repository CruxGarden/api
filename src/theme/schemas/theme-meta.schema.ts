import { z } from 'zod';

const GradientStopSchema = z.object({
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color'),
  offset: z
    .string()
    .regex(/^\d+%$/, 'Must be a percentage (e.g., "0%", "100%")'),
});

const GradientDefinitionSchema = z
  .object({
    id: z.string().min(1, 'Gradient ID is required for SVG rendering'),
    angle: z.number().min(0).max(360).optional(),
    stops: z.array(GradientStopSchema).min(2),
  })
  .strict();

const ThemeColorSchema = z
  .object({
    gradient: GradientDefinitionSchema.optional(),
    solid: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
      .optional(),
  })
  .refine((data) => data.gradient || data.solid, {
    message: 'Must have either gradient or solid color',
  });

const PaletteModeSchema = z.object({
  primary: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
  secondary: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
  tertiary: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
  quaternary: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
});

const BloomModeSchema = z.object({
  primary: ThemeColorSchema.optional(),
  secondary: ThemeColorSchema.optional(),
  tertiary: ThemeColorSchema.optional(),
  quaternary: ThemeColorSchema.optional(),
  borderColor: z.string().optional(),
  borderWidth: z.string().optional(),
  shadowEnabled: z.boolean().optional(),
  shadowColor: z.string().optional(),
  shadowOffsetX: z.string().optional(),
  shadowOffsetY: z.string().optional(),
  shadowBlurRadius: z.string().optional(),
  shadowOpacity: z.string().optional(),
});

const ContentModeSchema = z.object({
  backgroundColor: z.string().optional(),
  panelColor: z.string().optional(),
  textColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.string().optional(),
  borderRadius: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  font: z.enum(['sans-serif', 'serif', 'monospace']).optional(),
  panelShadowEnabled: z.boolean().optional(),
  panelShadowColor: z.string().optional(),
  panelShadowOffsetX: z.string().optional(),
  panelShadowOffsetY: z.string().optional(),
  panelShadowBlurRadius: z.string().optional(),
  panelShadowOpacity: z.string().optional(),
});

const ControlsModeSchema = z.object({
  buttonBackground: ThemeColorSchema.optional(),
  buttonTextColor: z.string().optional(),
  buttonBorderColor: z.string().optional(),
  buttonBorderWidth: z.string().optional(),
  buttonBorderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  buttonBorderRadius: z.string().optional(),
  buttonShadowEnabled: z.boolean().optional(),
  buttonShadowColor: z.string().optional(),
  buttonShadowOffsetX: z.string().optional(),
  buttonShadowOffsetY: z.string().optional(),
  buttonShadowBlurRadius: z.string().optional(),
  buttonShadowOpacity: z.string().optional(),
  linkColor: z.string().optional(),
  linkUnderlineStyle: z.enum(['none', 'underline', 'always']).optional(),
  selectionColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
});

const PaletteSchema = z.object({
  light: PaletteModeSchema.optional(),
  dark: PaletteModeSchema.optional(),
});

const BloomSchema = z.object({
  light: BloomModeSchema.optional(),
  dark: BloomModeSchema.optional(),
});

const ContentSchema = z.object({
  light: ContentModeSchema.optional(),
  dark: ContentModeSchema.optional(),
});

const ControlsSchema = z.object({
  light: ControlsModeSchema.optional(),
  dark: ControlsModeSchema.optional(),
});

export const ThemeMetaSchema = z
  .object({
    palette: PaletteSchema.optional(),
    bloom: BloomSchema.optional(),
    content: ContentSchema.optional(),
    controls: ControlsSchema.optional(),
  })
  .refine(
    (data) => data.palette || data.bloom || data.content || data.controls,
    {
      message:
        'Meta must contain at least one section (palette, bloom, content, or controls)',
    },
  );

export type ThemeMetaType = z.infer<typeof ThemeMetaSchema>;

export function validateThemeMeta(meta: unknown): ThemeMetaType {
  return ThemeMetaSchema.parse(meta);
}

export function validateThemeMetaSafe(meta: unknown) {
  return ThemeMetaSchema.safeParse(meta);
}
