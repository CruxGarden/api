import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsEmail, IsString } from 'class-validator';

export class AuthLoginDto {
  @ApiProperty({
    description: 'Email address of the user',
    example: 'user@example.com',
    format: 'email',
  })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Authentication code received via email',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsNotEmpty()
  @IsString()
  code: string;
}
