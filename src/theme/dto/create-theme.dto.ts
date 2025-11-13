import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ThemeMetaDto } from './theme-meta.dto';

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

  @ApiPropertyOptional({
    description: 'Theme type/category',
    example: 'nature',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Theme kind (light, dark, auto)',
    example: 'light',
  })
  @IsOptional()
  @IsString()
  kind?: string;

  @ApiPropertyOptional({
    description: 'System-provided theme (read-only, set internally)',
    example: false,
  })
  @IsOptional()
  system?: boolean;

  @ApiProperty({
    description: 'Theme metadata containing all styling configuration',
    type: ThemeMetaDto,
  })
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => ThemeMetaDto)
  meta: ThemeMetaDto;
}
