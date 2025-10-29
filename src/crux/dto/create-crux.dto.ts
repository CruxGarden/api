// src/cruxes/dto/create-crux.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { CruxStatus, CruxVisibility } from '../../common/types/enums';

export class CreateCruxDto {
  @ApiProperty({
    description: 'Unique slug identifier for the crux',
    example: 'my-awesome-crux',
    minLength: 1,
  })
  @IsNotEmpty()
  @IsString()
  slug: string;

  @ApiPropertyOptional({
    description: 'Optional title for the crux',
    example: 'My Awesome Crux',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Optional description for the crux',
    example: 'My Awesome Crux Description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Main content/data of the crux',
    example: 'This is the content of my crux',
  })
  @IsNotEmpty()
  @IsString()
  data: string;

  @ApiPropertyOptional({
    description: 'Type of crux content',
    example: 'text',
    default: 'text',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Theme ID for styling the crux',
    example: 'theme-123',
  })
  @IsOptional()
  @IsString()
  themeId?: string;

  @ApiPropertyOptional({
    description: 'Status of the crux',
    enum: CruxStatus,
    example: CruxStatus.LIVING,
    default: CruxStatus.LIVING,
  })
  @IsOptional()
  @IsEnum(CruxStatus)
  status?: CruxStatus;

  @ApiPropertyOptional({
    description: 'Visibility setting for the crux',
    enum: CruxVisibility,
    example: CruxVisibility.UNLISTED,
    default: CruxVisibility.UNLISTED,
  })
  @IsOptional()
  @IsEnum(CruxVisibility)
  visibility?: CruxVisibility;

  @ApiPropertyOptional({
    description: 'Array of tag names to associate with the crux',
    type: [String],
    example: ['technology', 'programming'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Optional metadata object for the crux',
    example: { key: 'value', custom: 'data' },
  })
  @IsOptional()
  meta?: any;

  // Internal fields set by service
  @ApiPropertyOptional({
    description: 'Unique identifier for the crux (auto-generated)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Unique key identifier for the crux (auto-generated)',
    example: 'abc123def',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional({
    description: 'Author ID (set internally from account)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  authorId?: string;

  @ApiPropertyOptional({
    description: 'Home ID (set internally from author)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  homeId?: string;
}
