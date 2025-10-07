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
import { AuthorRepository } from './author.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import AuthorRaw from './entities/author-raw.entity';
import Author from './entities/author.entity';

@Injectable()
export class AuthorService {
  private readonly logger: LoggerService;

  constructor(
    private readonly authorRepository: AuthorRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthorService');
    this.logger.debug('AuthorService initialized');
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

    // 4) create author
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
}
