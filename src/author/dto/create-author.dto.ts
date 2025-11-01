import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateAuthorDto {
  @ApiPropertyOptional({
    description: 'Unique identifier for the author',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Short key for the author',
    example: 'gHtdgqnJiE',
    format: 'string',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiProperty({
    description:
      'Username for the author (alphanumeric, hyphens, underscores only)',
    example: 'johndoe',
    minLength: 1,
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      'Username can only contain letters, numbers, hyphens, and underscores',
  })
  username: string;

  @ApiProperty({
    description: 'Display name for the author',
    example: 'John Doe',
  })
  @IsNotEmpty()
  @IsString()
  displayName: string;

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

  private _accountId?: string;

  get accountId(): string | undefined {
    return this._accountId;
  }

  set accountId(value: string) {
    this._accountId = value;
  }

  @ApiPropertyOptional({
    description: 'Home ID (set internally from primary home)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  homeId?: string;
}
