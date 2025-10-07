import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateAuthorDto {
  @ApiPropertyOptional({
    description: 'Display name for the author',
    example: 'John Doe',
  })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Email address of the author',
    example: 'john@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Bio or description of the author',
    example: 'Software developer and writer',
  })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({
    description: 'Website URL of the author',
    example: 'https://johndoe.com',
  })
  @IsOptional()
  @IsUrl()
  website?: string;

  @ApiPropertyOptional({
    description: 'Avatar URL for the author',
    example: 'https://example.com/avatar.jpg',
  })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;
}
