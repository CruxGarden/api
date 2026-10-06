import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const REPORT_REASONS = [
  'illegal',
  'harmful',
  'spam',
  'copyright',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export class CreateReportDto {
  @ApiProperty({ description: 'The published crux', format: 'uuid' })
  @IsUUID()
  cruxId: string;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason: ReportReason;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  details?: string;

  @ApiPropertyOptional({
    description: 'Where the operator may reach the reporter',
    format: 'email',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
