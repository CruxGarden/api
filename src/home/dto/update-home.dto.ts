import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateHomeDto } from './create-home.dto';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateHomeDto extends PartialType(CreateHomeDto) {
  @ApiPropertyOptional({
    description: 'Name of the home',
    example: 'Updated Garden Name',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Optional description of the home',
    example: 'An updated description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether this is the primary home',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  primary?: boolean;

  @ApiPropertyOptional({
    description: 'Type of the home',
    example: 'personal',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Kind of the home',
    example: 'garden',
  })
  @IsOptional()
  @IsString()
  kind?: string;

  @ApiPropertyOptional({
    description: 'Optional metadata for the home',
    example: { color: 'green', icon: 'flower' },
  })
  @IsOptional()
  meta?: any;
}
