import { IsNotEmpty, IsString, IsArray, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatDto {
  @ApiProperty({ description: 'Crux workspace ID' })
  @IsNotEmpty()
  @IsString()
  cruxId: string;

  @ApiProperty({ description: 'Conversation messages' })
  @IsArray()
  messages: { role: 'user' | 'assistant'; content: string }[];

  @ApiPropertyOptional({
    description: 'Model to use',
    default: 'claude-sonnet-4-20250514',
  })
  @IsOptional()
  @IsString()
  model?: string;
}
