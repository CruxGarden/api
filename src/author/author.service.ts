import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { GraphResponseDto } from './dto/graph-response.dto';
import { AuthorRepository } from './author.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import AuthorRaw from './entities/author-raw.entity';
import Author from './entities/author.entity';
import { CruxService } from '../crux/crux.service';
import { CreateCruxDto } from '../crux/dto/create-crux.dto';
import { CruxStatus, CruxVisibility } from '../common/types/enums';

@Injectable()
export class AuthorService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly authorRepository: AuthorRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly cruxService: CruxService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthorService');
  }

  asAuthor(data: AuthorRaw): Author {
    const entityFields = toEntityFields(data);
    return new Author(entityFields);
  }

  asAuthors(rows: AuthorRaw[]): Author[] {
    return rows.map((data) => this.asAuthor(data));
  }

  findAllQuery(): Knex.QueryBuilder<AuthorRaw, AuthorRaw[]> {
    return this.authorRepository.findAllQuery();
  }

  async findByAccountId(accountId: string): Promise<Author> {
    const { data: author, error } = await this.authorRepository.findBy(
      'account_id',
      accountId,
    );

    if (error || !author) {
      throw new NotFoundException('Author not found for this account');
    }

    return this.asAuthor(author);
  }

  async findById(authorId: string): Promise<Author> {
    const { data: author, error } = await this.authorRepository.findBy(
      'id',
      authorId,
    );

    if (error || !author) {
      throw new NotFoundException('Author not found');
    }

    return this.asAuthor(author);
  }

  async findByKey(key: string): Promise<Author> {
    const { data: author, error } = await this.authorRepository.findBy(
      'key',
      key,
    );

    if (error || !author) {
      throw new NotFoundException('Author not found');
    }

    return this.asAuthor(author);
  }

  async findByUsername(username: string): Promise<Author> {
    const { data: author, error } = await this.authorRepository.findBy(
      'username',
      username,
    );

    if (error || !author) {
      throw new NotFoundException('Author not found');
    }

    return this.asAuthor(author);
  }

  private async checkUsernameExists(username: string): Promise<Author | null> {
    const { data: author, error } = await this.authorRepository.findBy(
      'username',
      username,
    );

    if (error || !author) {
      return null;
    }

    return this.asAuthor(author);
  }

  private async checkAccountHasAuthor(
    accountId: string,
  ): Promise<Author | null> {
    const { data: author, error } = await this.authorRepository.findBy(
      'account_id',
      accountId,
    );

    if (error || !author) {
      return null;
    }

    return this.asAuthor(author);
  }

  private async createRootCrux(
    username: string,
    authorId: string,
    homeId: string,
    accountId: string,
  ): Promise<string> {
    const rootCruxDto: CreateCruxDto = {
      slug: `${username}-root`,
      title: 'Welcome to Crux Garden!',
      data: '## What are you thinking today?',
      type: 'markdown',
      authorId,
      homeId,
      accountId,
      status: CruxStatus.LIVING,
      visibility: CruxVisibility.UNLISTED,
    };

    const rootCrux = await this.cruxService.create(rootCruxDto);
    return rootCrux.id;
  }

  async create(createAuthorDto: CreateAuthorDto): Promise<Author> {
    createAuthorDto.id = this.keyMaster.generateId();
    createAuthorDto.key = this.keyMaster.generateKey();

    // 2) check if username already exists
    const existingByUsername = await this.checkUsernameExists(
      createAuthorDto.username,
    );
    if (existingByUsername)
      throw new ConflictException('Username already exists');

    // 3) check if account already has an author
    const existingByAccount = await this.checkAccountHasAuthor(
      createAuthorDto.accountId,
    );
    if (existingByAccount)
      throw new ConflictException('Account already has an author profile');

    // 4) create root crux for the author
    const rootCruxId = await this.createRootCrux(
      createAuthorDto.username,
      createAuthorDto.id,
      createAuthorDto.homeId,
      createAuthorDto.accountId,
    );
    createAuthorDto.rootId = rootCruxId;

    // 5) create author with root_id
    const created = await this.authorRepository.create(createAuthorDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Author creation error: ${created.error}`,
      );

    return this.asAuthor(created.data);
  }

  async update(
    authorKey: string,
    updateAuthorDto: UpdateAuthorDto,
  ): Promise<Author> {
    // 1) fetch author
    const authorToUpdate = await this.findByKey(authorKey);

    // 2) update author
    const updated = await this.authorRepository.update(
      authorToUpdate.id,
      updateAuthorDto,
    );
    if (updated.error)
      throw new InternalServerErrorException(
        `Author update error: ${updated.error}`,
      );

    return this.asAuthor(updated.data);
  }

  async delete(authorKey: string): Promise<null> {
    const authorToDelete = await this.findByKey(authorKey);

    const { error: deleteError } = await this.authorRepository.delete(
      authorToDelete.id,
    );
    if (deleteError) {
      throw new InternalServerErrorException(
        `Author deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  async getGraph(authorId: string): Promise<GraphResponseDto> {
    const { data, error } = await this.authorRepository.getGraphData(authorId);

    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to fetch graph data: ${error}`,
      );
    }

    // Format response
    return {
      nodes: data.nodes.map((node) => ({
        id: node.id,
        name: node.title || 'Untitled',
        slug: node.slug,
        type: node.type,
        status: node.status,
      })),
      links: data.links.map((link) => ({
        source: link.source_id,
        target: link.target_id,
        type: link.type as any, // Type from DB is string, will be validated by enum
      })),
    };
  }
}
