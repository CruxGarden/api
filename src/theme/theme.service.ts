import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateThemeDto } from './dto/create-theme.dto';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { ThemeRepository } from './theme.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { TagService } from '../tag/tag.service';
import { ResourceType } from '../common/types/enums';
import ThemeRaw from './entities/theme-raw.entity';
import Theme from './entities/theme.entity';
import Tag from '../tag/entities/tag.entity';

@Injectable()
export class ThemeService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly themeRepository: ThemeRepository,
    private readonly keyMaster: KeyMaster,
    private readonly tagService: TagService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ThemeService');
  }

  asTheme(data: ThemeRaw): Theme {
    const entityFields = toEntityFields(data);
    return new Theme(entityFields);
  }

  asThemes(rows: ThemeRaw[]): Theme[] {
    return rows.map((data) => this.asTheme(data));
  }

  findAllQuery(): Knex.QueryBuilder<ThemeRaw, ThemeRaw[]> {
    return this.themeRepository.findAllQuery();
  }

  async findById(id: string): Promise<Theme> {
    const { data: theme, error } = await this.themeRepository.findBy('id', id);

    if (error || !theme) {
      throw new NotFoundException('Theme not found');
    }

    return this.asTheme(theme);
  }

  async findByKey(key: string): Promise<Theme> {
    const { data: theme, error } = await this.themeRepository.findBy(
      'key',
      key,
    );

    if (error || !theme) {
      throw new NotFoundException('Theme not found');
    }

    return this.asTheme(theme);
  }

  async create(createThemeDto: CreateThemeDto): Promise<Theme> {
    createThemeDto.id = this.keyMaster.generateId();
    createThemeDto.key = this.keyMaster.generateKey();

    const created = await this.themeRepository.create(createThemeDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Theme creation error: ${created.error}`,
      );

    return this.asTheme(created.data);
  }

  async update(themeKey: string, updateDto: UpdateThemeDto): Promise<Theme> {
    // 1) fetch theme
    const themeToUpdate = await this.findByKey(themeKey);

    // 2) update theme
    const updated = await this.themeRepository.update(
      themeToUpdate.id,
      updateDto,
    );
    if (updated.error)
      throw new InternalServerErrorException(
        `Theme update error: ${updated.error}`,
      );

    return this.asTheme(updated.data);
  }

  async delete(themeKey: string): Promise<null> {
    const themeToDelete = await this.findByKey(themeKey);
    if (!themeToDelete) throw new NotFoundException('Theme not found');

    const { error: deleteError } = await this.themeRepository.delete(
      themeToDelete.id,
    );
    if (deleteError) {
      throw new InternalServerErrorException(
        `Theme deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  /* theme tags */

  async getTags(themeKey: string, filter?: string): Promise<Tag[]> {
    return this.tagService.getTags(ResourceType.THEME, themeKey, filter);
  }

  async syncTags(
    themeKey: string,
    labels: string[],
    authorId: string,
  ): Promise<Tag[]> {
    return this.tagService.syncTags(
      ResourceType.THEME,
      themeKey,
      labels,
      authorId,
    );
  }

  /* ~theme tags */
}
