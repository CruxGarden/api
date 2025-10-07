import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PathKind, PathType, PathVisibility } from '../../common/types/enums';

export class CreatePathDto {
  @ApiProperty({
    description: 'Unique slug identifier for the path',
    example: 'my-awesome-path',
    minLength: 1,
  })
  @IsNotEmpty()
  @IsString()
  slug: string;

  @ApiPropertyOptional({
    description: 'Optional title for the path',
    example: 'My Awesome Path',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Optional description for the path',
    example: 'This is a description of my path',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Type of the path',
    enum: PathType,
    example: PathType.LIVING,
    default: PathType.LIVING,
  })
  @IsOptional()
  @IsEnum(PathType)
  type?: PathType;

  @ApiPropertyOptional({
    description: 'Visibility setting for the path',
    enum: PathVisibility,
    example: PathVisibility.UNLISTED,
    default: PathVisibility.UNLISTED,
  })
  @IsOptional()
  @IsEnum(PathVisibility)
  visibility?: PathVisibility;

  @ApiProperty({
    description: 'Kind of path (guide or wander)',
    enum: PathKind,
    example: PathKind.WANDER,
  })
  @IsNotEmpty()
  @IsEnum(PathKind)
  kind: PathKind;

  @ApiProperty({
    description: 'Entry marker ID for the path',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  @IsUUID()
  entry: string;

  @ApiPropertyOptional({
    description: 'Optional theme ID for the path',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  themeId?: string;

  // Internal fields set by service
  @ApiPropertyOptional({
    description: 'Unique identifier for the path (auto-generated)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Unique key identifier for the path (auto-generated)',
    example: 'abc123def',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional({
    description: 'Author ID (set internally from account)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  authorId?: string;

  @ApiPropertyOptional({
    description: 'Account ID (set internally from auth)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  accountId?: string;
}
