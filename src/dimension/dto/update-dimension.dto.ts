import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  IsObject,
  ValidateIf,
} from 'class-validator';
import { DimensionType } from '../../common/types/enums';

export class UpdateDimensionDto {
  @ApiPropertyOptional({
    description: 'Type of dimensional relationship',
    enum: DimensionType,
    example: 'gate',
  })
  @IsOptional()
  @IsEnum(DimensionType)
  type?: string;

  @ApiPropertyOptional({
    description: 'Relationship role within its dimension type',
    example: 'membership',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  kind?: string;

  @ApiPropertyOptional({
    description: 'Relationship metadata; updates shallow-merge top-level keys',
    type: 'object',
    additionalProperties: true,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  meta?: Record<string, unknown>;

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
}
