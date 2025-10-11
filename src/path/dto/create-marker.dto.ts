import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreateMarkerDto {
  @ApiProperty({
    description: 'Path ID the marker belongs to',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  @IsString()
  pathId: string;

  @ApiProperty({
    description: 'Crux ID the marker points to',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  @IsString()
  cruxId: string;

  @ApiProperty({
    description: 'Order/position of the marker in the path',
    example: 0,
  })
  @IsInt()
  @Min(0)
  order: number;

  @ApiPropertyOptional({
    description: 'Optional note for the marker',
    example: 'This is an important marker',
  })
  @IsOptional()
  @IsString()
  note?: string;

  // Internal fields set by service
  @ApiPropertyOptional({
    description: 'Unique identifier for the marker (auto-generated)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Unique key identifier for the marker (auto-generated)',
    example: 'abc123def',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional({
    description: 'Author ID (set internally from account)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  authorId?: string;

  @ApiPropertyOptional({
    description: 'Home ID (set internally from primary home)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  homeId?: string;
}
