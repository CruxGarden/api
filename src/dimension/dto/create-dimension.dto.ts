import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { DimensionType } from '../../common/types/enums';

export class CreateDimensionDto {
  // Internal fields set by service
  @ApiPropertyOptional({
    description: 'Unique identifier for the dimension (auto-generated)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Unique key for the dimension (auto-generated)',
    example: 'TKSoWfISLG_',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiProperty({
    description: 'Target crux ID to create dimensional relationship with',
    example: 'crux_123',
  })
  @IsUUID()
  targetId: string;

  @ApiProperty({
    description: 'Type of dimensional relationship',
    enum: DimensionType,
    example: 'gate',
  })
  @IsEnum(DimensionType)
  type: string;

  @ApiPropertyOptional({
    description: 'Weight of the relationship (integer)',
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional({
    description: 'Optional note for the dimension',
    example: 'This is a note about the dimension',
  })
  @IsOptional()
  @IsString()
  note?: string;

  // internal use - populated by controller
  sourceId?: string;
  authorId?: string;
  homeId?: string;
}
