import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateHomeDto {
  @ApiPropertyOptional({
    description: 'Unique identifier for the home',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description:
      'Unique key identifier for the home (auto-generated if not provided)',
    example: 'my-home',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiProperty({
    description: 'Name of the home',
    example: 'My Garden',
    minLength: 1,
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'Optional description of the home',
    example: 'A personal knowledge garden for collecting ideas',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether this is the primary home',
    example: true,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  primary?: boolean;

  @ApiProperty({
    description: 'Type of the home',
    example: 'personal',
  })
  @IsNotEmpty()
  @IsString()
  type: string;

  @ApiProperty({
    description: 'Kind of the home',
    example: 'garden',
  })
  @IsNotEmpty()
  @IsString()
  kind: string;

  @ApiPropertyOptional({
    description: 'Optional metadata for the home',
    example: { color: 'blue', icon: 'tree' },
  })
  @IsOptional()
  meta?: any;
}
