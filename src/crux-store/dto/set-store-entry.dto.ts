import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { STORE_MODES, StoreMode } from '../entities/crux-store.entity';

const MODE_DESCRIPTION =
  'Access mode for this key. Fixed by the first write; a later write with a ' +
  'different mode is refused (409). ' +
  '`public`: anyone reads and writes one shared value. ' +
  '`protected`: needs a signed-in account; one private slot per account. ' +
  '`common`: one shared value that needs a signed-in account to write, ' +
  'increment or delete, and that anyone can read.';

export class SetStoreEntryDto {
  @ApiProperty({
    description: 'The value to store (any JSON-serializable type)',
  })
  @IsNotEmpty()
  value: any;

  @ApiPropertyOptional({
    description: MODE_DESCRIPTION,
    enum: STORE_MODES,
    default: 'protected',
  })
  @IsOptional()
  @IsEnum(STORE_MODES)
  mode?: StoreMode;
}

export class IncrementStoreEntryDto {
  @ApiPropertyOptional({
    description: 'Amount to increment by (default: 1)',
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  by?: number;

  @ApiPropertyOptional({
    description:
      'Mode for a key this increment creates. Ignored when the key exists ' +
      'unless it disagrees with the key’s mode (409). Defaults to ' +
      '`protected` when signed in, `public` otherwise.',
    enum: STORE_MODES,
  })
  @IsOptional()
  @IsEnum(STORE_MODES)
  mode?: StoreMode;
}
