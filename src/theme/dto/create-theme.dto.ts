import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateThemeDto {
  @ApiPropertyOptional({
    description: 'Unique identifier for the theme',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Unique identifier for the author',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  authorId?: string;

  @ApiPropertyOptional({
    description: 'Home ID (set internally from primary home)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  homeId?: string;

  @ApiProperty({
    description: 'Title of the theme',
    example: 'Ocean Blue',
    minLength: 1,
  })
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiPropertyOptional({
    description:
      'Unique key identifier for the theme (auto-generated if not provided)',
    example: 'ocean-blue',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional({
    description: 'Optional description of the theme',
    example: 'A calming blue theme inspired by ocean waters',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Primary color in hex format',
    example: '#2563eb',
  })
  @IsNotEmpty()
  @IsHexColor()
  primaryColor: string;

  @ApiProperty({
    description: 'Secondary color in hex format',
    example: '#3b82f6',
  })
  @IsNotEmpty()
  @IsHexColor()
  secondaryColor: string;

  @ApiProperty({
    description: 'Tertiary color in hex format',
    example: '#60a5fa',
  })
  @IsNotEmpty()
  @IsHexColor()
  tertiaryColor: string;

  @ApiProperty({
    description: 'Quaternary color in hex format',
    example: '#93c5fd',
  })
  @IsNotEmpty()
  @IsHexColor()
  quaternaryColor: string;

  @ApiPropertyOptional({
    description: 'Border radius value',
    example: '8px',
  })
  @IsOptional()
  @IsString()
  borderRadius?: string;

  @ApiPropertyOptional({
    description: 'Background color',
    example: '#ffffff',
  })
  @IsOptional()
  @IsString()
  backgroundColor?: string;

  @ApiPropertyOptional({
    description: 'Panel color',
    example: '#f5f5f5',
  })
  @IsOptional()
  @IsString()
  panelColor?: string;

  @ApiPropertyOptional({
    description: 'Text color',
    example: '#000000',
  })
  @IsOptional()
  @IsString()
  textColor?: string;

  @ApiPropertyOptional({
    description: 'Font family',
    example: 'Inter',
  })
  @IsOptional()
  @IsString()
  font?: string;

  @ApiPropertyOptional({
    description: 'Theme mode',
    example: 'light',
  })
  @IsOptional()
  @IsString()
  mode?: string;
}
