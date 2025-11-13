import { PartialType } from '@nestjs/swagger';
import { CreateThemeDto } from './create-theme.dto';

/**
 * Update theme DTO
 * Extends CreateThemeDto with all fields optional
 */
export class UpdateThemeDto extends PartialType(CreateThemeDto) {}
