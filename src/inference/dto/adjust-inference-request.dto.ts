import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Operator correction of one included request's charge; lower-only (ADR 0082). */
export class AdjustInferenceRequestDto {
  @ApiProperty({
    description: 'The new charge, below the current one',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  chargedMicrodollars: number;

  @ApiProperty({ description: 'Why, for the record', maxLength: 2000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  reason: string;
}
