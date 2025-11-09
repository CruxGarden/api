import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateThemeDto } from './create-theme.dto';
import { IsHexColor, IsOptional, IsString } from 'class-validator';

export class UpdateThemeDto extends PartialType(CreateThemeDto) {
  @ApiPropertyOptional({
    description: 'Name of the theme',
    example: 'Ocean Blue Updated',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Optional description of the theme',
    example: 'An updated calming blue theme inspired by ocean waters',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Primary color in hex format',
    example: '#2563eb',
  })
  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @ApiPropertyOptional({
    description: 'Secondary color in hex format',
    example: '#3b82f6',
  })
  @IsOptional()
  @IsHexColor()
  secondaryColor?: string;

  @ApiPropertyOptional({
    description: 'Tertiary color in hex format',
    example: '#60a5fa',
  })
  @IsOptional()
  @IsHexColor()
  tertiaryColor?: string;

  @ApiPropertyOptional({
    description: 'Quaternary color in hex format',
    example: '#93c5fd',
  })
  @IsOptional()
  @IsHexColor()
  quaternaryColor?: string;

  @ApiPropertyOptional({
    description: 'Border color',
    example: '#cccccc',
  })
  @IsOptional()
  @IsString()
  borderColor?: string;

  @ApiPropertyOptional({
    description: 'Border width',
    example: '1px',
  })
  @IsOptional()
  @IsString()
  borderWidth?: string;
}
