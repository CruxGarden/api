import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Gradient definition for theme colors
 */
export class GradientStopDto {
  @ApiPropertyOptional({
    description: 'Color at this gradient stop',
    example: '#4dd9b8',
  })
  @IsString()
  color: string;

  @ApiPropertyOptional({
    description: 'Position of stop as percentage',
    example: '0%',
  })
  @IsString()
  offset: string;
}

export class GradientDefinitionDto {
  @ApiPropertyOptional({
    description:
      'Unique identifier for the gradient (required for SVG rendering)',
    example: 'ocean-depths-primary',
  })
  @IsString()
  id: string;

  @ApiPropertyOptional({
    description: 'Gradient angle in degrees',
    example: 135,
  })
  angle?: number;

  @ApiPropertyOptional({
    description: 'Gradient stops',
    type: [GradientStopDto],
  })
  @ValidateNested({ each: true })
  @Type(() => GradientStopDto)
  stops: GradientStopDto[];
}

/**
 * Color with optional gradient
 */
export class ThemeColorDto {
  @ApiPropertyOptional({ description: 'Gradient definition' })
  @IsOptional()
  @ValidateNested()
  @Type(() => GradientDefinitionDto)
  gradient?: GradientDefinitionDto;

  @ApiPropertyOptional({
    description: 'Solid color fallback',
    example: '#4dd9b8',
  })
  @IsOptional()
  @IsString()
  solid?: string;
}

/**
 * Palette colors for a mode
 */
export class PaletteModeDto {
  @ApiPropertyOptional({ description: 'Primary color', example: '#4dd9b8' })
  @IsOptional()
  @IsString()
  primary?: string;

  @ApiPropertyOptional({ description: 'Secondary color', example: '#6de8ca' })
  @IsOptional()
  @IsString()
  secondary?: string;

  @ApiPropertyOptional({ description: 'Tertiary color', example: '#3dbfa0' })
  @IsOptional()
  @IsString()
  tertiary?: string;

  @ApiPropertyOptional({ description: 'Quaternary color', example: '#357d6a' })
  @IsOptional()
  @IsString()
  quaternary?: string;
}

/**
 * Bloom styling for a mode
 */
export class BloomModeDto {
  @ApiPropertyOptional({ description: 'Primary bloom color' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThemeColorDto)
  primary?: ThemeColorDto;

  @ApiPropertyOptional({ description: 'Secondary bloom color' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThemeColorDto)
  secondary?: ThemeColorDto;

  @ApiPropertyOptional({ description: 'Tertiary bloom color' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThemeColorDto)
  tertiary?: ThemeColorDto;

  @ApiPropertyOptional({ description: 'Quaternary bloom color' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThemeColorDto)
  quaternary?: ThemeColorDto;

  @ApiPropertyOptional({
    description: 'Bloom border color',
    example: '#4dd9b8',
  })
  @IsOptional()
  @IsString()
  borderColor?: string;

  @ApiPropertyOptional({ description: 'Bloom border width', example: '2' })
  @IsOptional()
  @IsString()
  borderWidth?: string;

  @ApiPropertyOptional({ description: 'Enable bloom shadow', example: false })
  @IsOptional()
  @IsBoolean()
  shadowEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Shadow color', example: '#000000' })
  @IsOptional()
  @IsString()
  shadowColor?: string;

  @ApiPropertyOptional({ description: 'Shadow offset X', example: '0' })
  @IsOptional()
  @IsString()
  shadowOffsetX?: string;

  @ApiPropertyOptional({ description: 'Shadow offset Y', example: '2' })
  @IsOptional()
  @IsString()
  shadowOffsetY?: string;

  @ApiPropertyOptional({ description: 'Shadow blur radius', example: '4' })
  @IsOptional()
  @IsString()
  shadowBlurRadius?: string;

  @ApiPropertyOptional({ description: 'Shadow opacity', example: '0.1' })
  @IsOptional()
  @IsString()
  shadowOpacity?: string;
}

/**
 * Content styling for a mode
 */
export class ContentModeDto {
  @ApiPropertyOptional({ description: 'Background color', example: '#0f1214' })
  @IsOptional()
  @IsString()
  backgroundColor?: string;

  @ApiPropertyOptional({ description: 'Panel color', example: '#1a1d21' })
  @IsOptional()
  @IsString()
  panelColor?: string;

  @ApiPropertyOptional({ description: 'Text color', example: '#e8eef2' })
  @IsOptional()
  @IsString()
  textColor?: string;

  @ApiPropertyOptional({ description: 'Border color', example: '#2f3338' })
  @IsOptional()
  @IsString()
  borderColor?: string;

  @ApiPropertyOptional({ description: 'Border width', example: '1' })
  @IsOptional()
  @IsString()
  borderWidth?: string;

  @ApiPropertyOptional({ description: 'Border radius', example: '8' })
  @IsOptional()
  @IsString()
  borderRadius?: string;

  @ApiPropertyOptional({
    description: 'Border style',
    example: 'solid',
    enum: ['solid', 'dashed', 'dotted'],
  })
  @IsOptional()
  @IsString()
  borderStyle?: 'solid' | 'dashed' | 'dotted';

  @ApiPropertyOptional({
    description: 'Font type',
    example: 'sans-serif',
    enum: ['sans-serif', 'serif', 'monospace'],
  })
  @IsOptional()
  @IsString()
  font?: string;

  @ApiPropertyOptional({ description: 'Enable panel shadow', example: false })
  @IsOptional()
  @IsBoolean()
  panelShadowEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Panel shadow color',
    example: '#000000',
  })
  @IsOptional()
  @IsString()
  panelShadowColor?: string;

  @ApiPropertyOptional({ description: 'Panel shadow offset X', example: '0' })
  @IsOptional()
  @IsString()
  panelShadowOffsetX?: string;

  @ApiPropertyOptional({ description: 'Panel shadow offset Y', example: '2' })
  @IsOptional()
  @IsString()
  panelShadowOffsetY?: string;

  @ApiPropertyOptional({
    description: 'Panel shadow blur radius',
    example: '8',
  })
  @IsOptional()
  @IsString()
  panelShadowBlurRadius?: string;

  @ApiPropertyOptional({ description: 'Panel shadow opacity', example: '0.05' })
  @IsOptional()
  @IsString()
  panelShadowOpacity?: string;
}

/**
 * Controls styling for a mode
 */
export class ControlsModeDto {
  @ApiPropertyOptional({ description: 'Button background color' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThemeColorDto)
  buttonBackground?: ThemeColorDto;

  @ApiPropertyOptional({ description: 'Button text color', example: '#0f1214' })
  @IsOptional()
  @IsString()
  buttonTextColor?: string;

  @ApiPropertyOptional({
    description: 'Button border color',
    example: '#4dd9b8',
  })
  @IsOptional()
  @IsString()
  buttonBorderColor?: string;

  @ApiPropertyOptional({ description: 'Button border width', example: '1' })
  @IsOptional()
  @IsString()
  buttonBorderWidth?: string;

  @ApiPropertyOptional({
    description: 'Button border style',
    example: 'solid',
    enum: ['solid', 'dashed', 'dotted'],
  })
  @IsOptional()
  @IsString()
  buttonBorderStyle?: 'solid' | 'dashed' | 'dotted';

  @ApiPropertyOptional({ description: 'Button border radius', example: '6' })
  @IsOptional()
  @IsString()
  buttonBorderRadius?: string;

  @ApiPropertyOptional({ description: 'Enable button shadow', example: false })
  @IsOptional()
  @IsBoolean()
  buttonShadowEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Button shadow color',
    example: '#000000',
  })
  @IsOptional()
  @IsString()
  buttonShadowColor?: string;

  @ApiPropertyOptional({ description: 'Button shadow offset X', example: '0' })
  @IsOptional()
  @IsString()
  buttonShadowOffsetX?: string;

  @ApiPropertyOptional({ description: 'Button shadow offset Y', example: '2' })
  @IsOptional()
  @IsString()
  buttonShadowOffsetY?: string;

  @ApiPropertyOptional({
    description: 'Button shadow blur radius',
    example: '4',
  })
  @IsOptional()
  @IsString()
  buttonShadowBlurRadius?: string;

  @ApiPropertyOptional({ description: 'Button shadow opacity', example: '0.1' })
  @IsOptional()
  @IsString()
  buttonShadowOpacity?: string;

  @ApiPropertyOptional({ description: 'Link color', example: '#2563eb' })
  @IsOptional()
  @IsString()
  linkColor?: string;

  @ApiPropertyOptional({
    description: 'Link underline style',
    example: 'underline',
    enum: ['none', 'underline', 'always'],
  })
  @IsOptional()
  @IsString()
  linkUnderlineStyle?: 'none' | 'underline' | 'always';
}

/**
 * Palette section with light/dark modes
 */
export class PaletteDto {
  @ApiPropertyOptional({ description: 'Light mode palette' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaletteModeDto)
  light?: PaletteModeDto;

  @ApiPropertyOptional({ description: 'Dark mode palette' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaletteModeDto)
  dark?: PaletteModeDto;
}

/**
 * Bloom section with light/dark modes
 */
export class BloomDto {
  @ApiPropertyOptional({ description: 'Light mode bloom styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BloomModeDto)
  light?: BloomModeDto;

  @ApiPropertyOptional({ description: 'Dark mode bloom styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BloomModeDto)
  dark?: BloomModeDto;
}

/**
 * Content section with light/dark modes
 */
export class ContentDto {
  @ApiPropertyOptional({ description: 'Light mode content styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContentModeDto)
  light?: ContentModeDto;

  @ApiPropertyOptional({ description: 'Dark mode content styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContentModeDto)
  dark?: ContentModeDto;
}

/**
 * Controls section with light/dark modes
 */
export class ControlsDto {
  @ApiPropertyOptional({ description: 'Light mode controls styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ControlsModeDto)
  light?: ControlsModeDto;

  @ApiPropertyOptional({ description: 'Dark mode controls styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ControlsModeDto)
  dark?: ControlsModeDto;
}

/**
 * Complete theme metadata structure
 * Matches the structure sent by ThemeBuilder
 */
export class ThemeMetaDto {
  @ApiPropertyOptional({
    description: 'Color palette for light and dark modes',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaletteDto)
  palette?: PaletteDto;

  @ApiPropertyOptional({ description: 'Bloom component styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BloomDto)
  bloom?: BloomDto;

  @ApiPropertyOptional({ description: 'Content area styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContentDto)
  content?: ContentDto;

  @ApiPropertyOptional({ description: 'Controls (buttons, links) styling' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ControlsDto)
  controls?: ControlsDto;
}
