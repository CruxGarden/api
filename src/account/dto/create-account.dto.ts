import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { AccountRole } from '../../common/types/enums';

export class CreateAccountDto {
  @ApiProperty({
    description: 'Unique identifier for the account',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsNotEmpty()
  @IsString()
  id: string;

  @ApiProperty({
    description: 'Unique key for the account (auto-generated)',
    example: 'TKSoWfISLG_',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiProperty({
    description: 'Email address for the account',
    example: 'user@example.com',
    format: 'email',
  })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Role for the account',
    example: AccountRole.AUTHOR,
    enum: AccountRole,
    default: AccountRole.AUTHOR,
  })
  @IsOptional()
  @IsNotEmpty()
  @IsEnum(AccountRole)
  role?: AccountRole;
}
