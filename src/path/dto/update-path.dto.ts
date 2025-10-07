import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PathKind, PathType, PathVisibility } from '../../common/types/enums';

export class UpdatePathDto {
  @ApiPropertyOptional({
    description: 'Updated title for the path',
    example: 'My Updated Path Title',
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: 'Updated description for the path',
    example: 'Updated description for my path',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated type of the path',
    enum: PathType,
    example: PathType.FROZEN,
  })
  @IsOptional()
  @IsEnum(PathType)
  type?: PathType;

  @ApiPropertyOptional({
    description: 'Updated visibility setting for the path',
    enum: PathVisibility,
    example: PathVisibility.PUBLIC,
  })
  @IsOptional()
  @IsEnum(PathVisibility)
  visibility?: PathVisibility;

  @ApiPropertyOptional({
    description: 'Updated kind of path (guide or wander)',
    enum: PathKind,
    example: PathKind.GUIDE,
  })
  @IsOptional()
  @IsEnum(PathKind)
  kind?: PathKind;

  @ApiPropertyOptional({
    description: 'Updated entry marker ID for the path',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  @IsOptional()
  @IsUUID()
  entry?: string;

  @ApiPropertyOptional({
    description: 'Updated theme ID for the path',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  themeId?: string;
}
