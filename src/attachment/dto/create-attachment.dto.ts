import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreateAttachmentDto {
  @ApiPropertyOptional({
    description: 'Unique identifier for the attachment (auto-generated)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Unique key for the attachment (auto-generated)',
    example: 'TKSoWfISLG_',
  })
  @IsOptional()
  @IsString()
  key?: string;

  @ApiProperty({
    description: 'Type of the attachment',
    example: 'image',
  })
  @IsNotEmpty()
  @IsString()
  type: string;

  @ApiProperty({
    description: 'Kind of the attachment',
    example: 'photo',
  })
  @IsNotEmpty()
  @IsString()
  kind: string;

  @ApiPropertyOptional({
    description: 'Metadata for the attachment',
    example: { width: 1920, height: 1080 },
  })
  @IsOptional()
  meta?: any;

  @ApiProperty({
    description: 'Resource ID the attachment belongs to',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  @IsString()
  resourceId: string;

  @ApiProperty({
    description: 'Type of resource the attachment belongs to',
    example: 'crux',
  })
  @IsNotEmpty()
  @IsString()
  resourceType: string;

  @ApiPropertyOptional({
    description: 'Author ID (set internally from account)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  authorId?: string;

  @ApiPropertyOptional({
    description: 'Home ID (set internally from primary home)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsString()
  homeId?: string;

  @ApiProperty({
    description: 'Encoding of the file',
    example: '7bit',
  })
  @IsNotEmpty()
  @IsString()
  encoding: string;

  @ApiProperty({
    description: 'MIME type of the file',
    example: 'image/png',
  })
  @IsNotEmpty()
  @IsString()
  mimeType: string;

  @ApiProperty({
    description: 'Filename of the attachment',
    example: 'screenshot.png',
  })
  @IsNotEmpty()
  @IsString()
  filename: string;

  @ApiProperty({
    description: 'File size in bytes',
    example: 1024000,
  })
  @IsInt()
  @Min(0)
  size: number;
}
