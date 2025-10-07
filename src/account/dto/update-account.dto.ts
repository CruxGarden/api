import { IsEmail, IsOptional } from 'class-validator';

export class UpdateAccountDto {
  @IsOptional()
  accountId?: string;

  @IsEmail()
  email: string;
}
