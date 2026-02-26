import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  Patch,
  Param,
  Delete,
  Put,
  Query,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ThemeService } from './theme.service';
import { CreateThemeDto } from './dto/create-theme.dto';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { DbService } from '../common/services/db.service';
import { ThemeSwagger } from './theme.swagger';
import { LoggerService } from '../common/services/logger.service';
import { SyncTagsDto } from '../tag/dto/sync-tags.dto';
import Theme from './entities/theme.entity';
import ThemeRaw from './entities/theme-raw.entity';
import Tag from '../tag/entities/tag.entity';
import { AuthorService } from '../author/author.service';
import { HomeService } from '../home/home.service';

@Controller('themes')
@UseGuards(AuthGuard)
@ThemeSwagger.Controller()
export class ThemeController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly themeService: ThemeService,
    private readonly dbService: DbService,
    private readonly homeService: HomeService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ThemeController');
  }

  async canManageTheme(id: string, req: AuthRequest): Promise<void> {
    const theme = await this.themeService.findById(id);
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!theme || !author) {
      throw new NotFoundException('Theme or Author not found');
    }
    if (theme.authorId !== author.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this theme',
      );
    }
  }

  @Get()
  @ThemeSwagger.GetAll()
  async getAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Theme[]> {
    const query = this.themeService.findAllQuery();
    return this.dbService.paginate<ThemeRaw, Theme>({
      model: Theme,
      query,
      request: req,
      response: res,
    }) as Promise<Theme[]>;
  }

  @Get(':id')
  @ThemeSwagger.GetByKey()
  async getById(@Param('id') id: string): Promise<Theme> {
    return this.themeService.findById(id);
  }

  @Post()
  @ThemeSwagger.Create()
  async create(
    @Body() createThemeDto: CreateThemeDto,
    @Req() req: AuthRequest,
  ): Promise<Theme> {
    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author) {
      throw new NotFoundException('Author not found for this account');
    }
    const home = await this.homeService.primary();
    createThemeDto.authorId = author.id;
    createThemeDto.homeId = home.id;
    return this.themeService.create(createThemeDto);
  }

  @Patch(':id')
  @ThemeSwagger.Update()
  async update(
    @Param('id') id: string,
    @Body() updateThemeDto: UpdateThemeDto,
    @Req() req: AuthRequest,
  ): Promise<Theme> {
    await this.canManageTheme(id, req);
    return this.themeService.update(id, updateThemeDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ThemeSwagger.Delete()
  async delete(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    await this.canManageTheme(id, req);
    return this.themeService.delete(id);
  }

  /* theme tags */

  @Get(':id/tags')
  @ThemeSwagger.GetTags()
  async getTags(
    @Param('id') id: string,
    @Query('filter') filter?: string,
  ): Promise<Tag[]> {
    return this.themeService.getTags(id, filter);
  }

  @Put(':id/tags')
  @ThemeSwagger.SyncTags()
  async syncTags(
    @Param('id') id: string,
    @Body() syncTagsDto: SyncTagsDto,
    @Req() req: AuthRequest,
  ): Promise<Tag[]> {
    await this.canManageTheme(id, req);
    const author = await this.authorService.findByAccountId(req.account.id);
    return this.themeService.syncTags(id, syncTagsDto.labels, author.id);
  }

  /* ~theme tags */
}
