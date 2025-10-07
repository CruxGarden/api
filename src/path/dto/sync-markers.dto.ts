import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MarkerInput {
  @ApiProperty({
    description: 'Crux key for the marker',
    example: 'crux-key-123',
  })
  @IsString()
  cruxKey: string;

  @ApiProperty({
    description: 'Order/position of the marker in the path',
    example: 0,
  })
  @IsInt()
  @Min(0)
  order: number;

  @ApiProperty({
    description: 'Optional note for the marker',
    example: 'This is an important marker',
    required: false,
  })
  @IsOptional()
  @IsString()
  note?: string;
}

export class SyncMarkersDto {
  @ApiProperty({
    description: 'Array of markers to sync for the path',
    type: [MarkerInput],
    example: [
      { cruxKey: 'crux-1', order: 0, note: 'First marker' },
      { cruxKey: 'crux-2', order: 1 },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarkerInput)
  markers: MarkerInput[];
}
