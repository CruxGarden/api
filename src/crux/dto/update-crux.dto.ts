import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsArray } from 'class-validator';
import { CruxStatus, CruxVisibility } from '../../common/types/enums';

export class UpdateCruxDto {
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
