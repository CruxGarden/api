import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsArray,
  ValidateIf,
} from 'class-validator';
import { CruxKind, CruxStatus, CruxVisibility } from '../../common/types/enums';

export class UpdateCruxDto {
  @ApiPropertyOptional({
    description: 'Updated slug (URL-safe identifier)',
    example: 'my-updated-slug',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({
    description: 'Updated title for the crux',
    example: 'My Updated Crux Title',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Updated description for the crux',
    example: 'My Updated Crux Description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated content/data of the crux',
    example: 'This is the updated content of my crux',
  })
  @IsOptional()
  @IsString()
  data?: string;

  @ApiPropertyOptional({
    description: 'Updated type of crux content',
    example: 'text',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Updated kind of crux (subcategory). Set to null to clear.',
    enum: CruxKind,
    example: CruxKind.WEBAPP,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(CruxKind)
  kind?: CruxKind | null;

  @ApiPropertyOptional({
    description: 'Updated theme ID for styling the crux',
    example: 'theme-456',
  })
  @IsOptional()
  @IsString()
  themeId?: string;

  @ApiPropertyOptional({
    description: 'Updated status of the crux',
    enum: CruxStatus,
    example: CruxStatus.FROZEN,
  })
  @IsOptional()
  @IsEnum(CruxStatus)
  status?: CruxStatus;

  @ApiPropertyOptional({
    description: 'Updated visibility setting for the crux',
    enum: CruxVisibility,
    example: CruxVisibility.PUBLIC,
  })
  @IsOptional()
  @IsEnum(CruxVisibility)
  visibility?: CruxVisibility;

  @ApiPropertyOptional({
    description: 'Updated array of tag names to associate with the crux',
    type: [String],
    example: ['updated-tag', 'new-category'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Updated metadata object for the crux',
    example: { key: 'updated-value', custom: 'updated-data' },
  })
  @IsOptional()
  meta?: any;
}
