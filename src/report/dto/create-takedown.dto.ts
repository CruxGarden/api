import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateTakedownDto {
  @ApiProperty({ description: 'The crux to take down', format: 'uuid' })
  @IsUUID()
  cruxId: string;

  @ApiProperty({ description: 'Why, for the record', maxLength: 2000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({
    description: 'The report that prompted it',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  reportId?: string;
}
