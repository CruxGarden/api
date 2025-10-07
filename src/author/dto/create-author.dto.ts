import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
    description: 'Username for the author',
    example: 'johndoe',
    minLength: 1,
  })
  @IsNotEmpty()
  @IsString()
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

  private _accountId?: string;

  get accountId(): string | undefined {
    return this._accountId;
  }

  set accountId(value: string) {
    this._accountId = value;
  }
}
