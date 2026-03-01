import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MarkerInput {
  @ApiProperty({
    description: 'Crux ID for the marker',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  cruxId: string;

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
      {
        cruxId: '550e8400-e29b-41d4-a716-446655440000',
        order: 0,
        note: 'First marker',
      },
      { cruxId: '660e8400-e29b-41d4-a716-446655440000', order: 1 },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarkerInput)
  markers: MarkerInput[];
}
