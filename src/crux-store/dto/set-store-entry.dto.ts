import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional } from 'class-validator';

export class SetStoreEntryDto {
  @ApiProperty({ description: 'The value to store (any JSON-serializable type)' })
  @IsNotEmpty()
  value: any;

  @ApiPropertyOptional({
    description: 'Access mode for this key',
    enum: ['public', 'protected'],
    default: 'protected',
  })
  @IsOptional()
  @IsEnum(['public', 'protected'])
  mode?: 'public' | 'protected';
}

export class IncrementStoreEntryDto {
  @ApiPropertyOptional({
    description: 'Amount to increment by (default: 1)',
    default: 1,
  })
  @IsOptional()
  by?: number;
}
