import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UploadArtifactDto {
  @ApiProperty({
    description: 'Type of the artifact',
    example: 'image',
  })
  @IsNotEmpty()
  @IsString()
  type: string;

  @ApiProperty({
    description: 'Kind of the artifact',
    example: 'photo',
  })
  @IsNotEmpty()
  @IsString()
  kind: string;

  @ApiPropertyOptional({
    description: 'Metadata for the artifact',
    example: { width: 1920, height: 1080 },
  })
  @IsOptional()
  meta?: string; // Will be parsed from form data as JSON string
}
