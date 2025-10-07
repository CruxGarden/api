import { IsArray, IsString, Length, Matches } from 'class-validator';

export class SyncTagsDto {
  @IsArray()
  @IsString({ each: true })
  @Length(1, 50, {
    each: true,
    message: 'Each tag label must be between 1 and 50 characters',
  })
  @Matches(/^[a-z0-9\-]+$/, {
    each: true,
    message:
      'Each tag label must be lowercase and can only contain letters, numbers, and hyphens (kebab-case)',
  })
  labels: string[];
}
