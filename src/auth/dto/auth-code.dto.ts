import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsEmail } from 'class-validator';

export class AuthCodeDto {
  @ApiProperty({
    description: 'Email address to send authentication code to',
    example: 'user@example.com',
    format: 'email',
  })
  @IsNotEmpty()
  @IsEmail()
  email: string;
}
