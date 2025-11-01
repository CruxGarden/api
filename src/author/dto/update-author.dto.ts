import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
} from 'class-validator';

export class UpdateAuthorDto {
  @ApiPropertyOptional({
    description:
      'Username for the author (alphanumeric, hyphens, underscores only)',
    example: 'johndoe',
  })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Username cannot be empty' })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      'Username can only contain letters, numbers, hyphens, and underscores',
  })
  username?: string;

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
    description: 'Root Crux ID for the author',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  rootId?: string;

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
