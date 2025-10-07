import {
  Controller,
  Get,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Patch,
  Body,
  NotFoundException,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthRequest } from '../common/types/interfaces';
import { AuthorService } from './author.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { DbService } from '../common/services/db.service';
import { AuthorSwagger } from './author.swagger';
import { LoggerService } from '../common/services/logger.service';
import { CruxService } from '../crux/crux.service';
import { AuthorEmbed, PathPrefix } from '../common/types/enums';
import { stripPathPrefix } from '../common/helpers/path-helpers';
import Author from './entities/author.entity';
import AuthorRaw from './entities/author-raw.entity';

@Controller('authors')
@UseGuards(AuthGuard)
@AuthorSwagger.Controller()
export class AuthorController {
  private readonly logger: LoggerService;

  constructor(
    private readonly authorService: AuthorService,
    private readonly cruxService: CruxService,
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthorController');
    this.logger.debug('AuthorController initialized');
  }

  async canManageAuthor(authorKey: string, req: AuthRequest): Promise<boolean> {
    const author = await this.authorService.findByKey(authorKey);
    if (!author) {
      throw new NotFoundException('Author not found');
    }
    if (author.accountId !== req.account.id) {
      throw new ForbiddenException(
        'You do not have permission to manage this author',
      );
    }
    return true;
  }

  @Get()
  @AuthorSwagger.FindAll()
  async getAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Author[]> {
    const query = this.authorService.findAllQuery();
    return this.dbService.paginate<AuthorRaw, Author>({
      model: Author,
      query,
      request: req,
      response: res,
    }) as Promise<Author[]>;
  }

  @Get(':identifier')
  @AuthorSwagger.GetByIdentifier()
  async getByIdentifier(
    @Param('identifier') identifier: string,
    @Query('embed') embed?: AuthorEmbed,
  ): Promise<Author> {
    let author: Author;
    const { hasPrefix, value } = stripPathPrefix(
      identifier,
      PathPrefix.USERNAME,
    );
    if (hasPrefix) {
      author = await this.authorService.findByUsername(value);
    } else {
      author = await this.authorService.findByKey(value);
    }

    if (embed === AuthorEmbed.HOME && author.homeId) {
      const homeCrux = await this.cruxService.findById(author.homeId);
      author.home = homeCrux;
    }

    return author;
  }

  @Post()
  @AuthorSwagger.Create()
  async create(
    @Body() createAuthorDto: CreateAuthorDto,
    @Req() req: AuthRequest,
  ): Promise<Author> {
    createAuthorDto.accountId = req.account.id;
    return this.authorService.create(createAuthorDto);
  }

  @Patch(':authorKey')
  @AuthorSwagger.Update()
  async update(
    @Param('authorKey') authorKey: string,
    @Body() updateAuthorDto: UpdateAuthorDto,
    @Req() req: AuthRequest,
  ): Promise<Author> {
    await this.canManageAuthor(authorKey, req);
    return this.authorService.update(authorKey, updateAuthorDto);
  }

  @Delete(':authorKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthorSwagger.Delete()
  async delete(
    @Param('authorKey') authorKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    await this.canManageAuthor(authorKey, req);
    return this.authorService.delete(authorKey);
  }
}
