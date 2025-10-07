import { IsString } from 'class-validator';

export class DeleteAccountDto {
  @IsString()
  confirmationText: string;
}
