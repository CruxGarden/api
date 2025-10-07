import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class UpdateTagDto {
  @IsNotEmpty()
  @IsString()
  @Length(1, 50, { message: 'Tag label must be between 1 and 50 characters' })
  @Matches(/^[a-z0-9\-]+$/, {
    message:
      'Tag label must be lowercase and can only contain letters, numbers, and hyphens (kebab-case)',
  })
  label: string;

  @IsOptional()
  @IsBoolean()
  system?: boolean;
}
