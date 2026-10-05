import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SuspendAccountDto {
  @ApiProperty({ description: 'Why, for the record', maxLength: 2000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  reason: string;
}
