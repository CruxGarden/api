import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import {
  ACCEPTED_STORE_MODES,
  normalizeStoreMode,
  STORE_MODES,
  StoreMode,
} from '../entities/crux-store.entity';

const MODE_DESCRIPTION =
  'Access mode for this key. Fixed by the first write; a later write with a ' +
  'different mode is refused (409). Every write needs a signed-in account. ' +
  '`public`: one shared value that anyone reads. ' +
  '`protected`: one private slot per account, read only by its owner.';

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
  @Transform(({ value }) => normalizeStoreMode(value))
  @IsIn(ACCEPTED_STORE_MODES)
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
      '`protected`.',
    enum: STORE_MODES,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeStoreMode(value))
  @IsIn(ACCEPTED_STORE_MODES)
  mode?: StoreMode;
}
