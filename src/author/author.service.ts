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
import AuthorRaw from './entities/author-raw.entity';
import Author from './entities/author.entity';
import { ArtifactService } from '../artifact/artifact.service';

@Injectable()
export class AuthorService {
  constructor(
    private readonly authorRepository: AuthorRepository,
    private readonly keyMaster: KeyMaster,
    private readonly artifactService: ArtifactService,
  ) {}

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

  async findByUsername(username: string): Promise<Author> {
    const { data: author, error } =
      await this.authorRepository.findByUsername(username);

    if (error || !author) {
      throw new NotFoundException('Author not found');
    }

    return this.asAuthor(author);
  }

  async checkUsernameExists(username: string): Promise<Author | null> {
    const { data: author, error } =
      await this.authorRepository.findByUsername(username);

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
    authorId: string,
    updateAuthorDto: UpdateAuthorDto,
  ): Promise<Author> {
    // 1) fetch author
    const authorToUpdate = await this.findById(authorId);

    // 2) if updating username, check if already in use by another author (case-insensitive)
    if (
      updateAuthorDto.username &&
      updateAuthorDto.username.toLowerCase() !==
        authorToUpdate.username.toLowerCase()
    ) {
      const existingAuthor = await this.checkUsernameExists(
        updateAuthorDto.username,
      );
      if (existingAuthor) {
        throw new ConflictException('Username already in use');
      }
    }

    // 3) update author
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

  async delete(authorId: string): Promise<null> {
    const authorToDelete = await this.findById(authorId);

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

  async uploadAvatar(
    authorId: string,
    file: Express.Multer.File,
  ): Promise<Author> {
    const author = await this.findById(authorId);

    // Delete any existing avatar artifact
    try {
      const existing = await this.artifactService.findByResourceAndKind(
        'author',
        authorId,
        'avatar',
      );
      for (const att of existing) {
        await this.artifactService.deleteWithFile(att.id);
      }
    } catch {
      // No existing avatar, that's fine
    }

    // Create new avatar artifact
    await this.artifactService.createWithFile(
      'author',
      authorId,
      author.homeId,
      authorId,
      { type: 'image', kind: 'avatar' },
      file,
    );

    // Update author meta with avatar URL
    const meta = {
      ...(author.meta || {}),
      avatarUrl: `/authors/${authorId}/avatar`,
    };
    const updated = await this.authorRepository.update(authorId, { meta });
    if (updated.error) {
      throw new InternalServerErrorException(
        `Avatar update error: ${updated.error}`,
      );
    }

    return this.asAuthor(updated.data);
  }

  async removeAvatar(authorId: string): Promise<Author> {
    await this.findById(authorId);

    // Delete avatar artifacts
    try {
      const existing = await this.artifactService.findByResourceAndKind(
        'author',
        authorId,
        'avatar',
      );
      for (const att of existing) {
        await this.artifactService.deleteWithFile(att.id);
      }
    } catch {
      // No existing avatar
    }

    // Clear avatarUrl from meta
    const author = await this.findById(authorId);
    const meta = { ...(author.meta || {}) } as Record<string, unknown>;
    delete meta.avatarUrl;
    const updated = await this.authorRepository.update(authorId, { meta });
    if (updated.error) {
      throw new InternalServerErrorException(
        `Avatar remove error: ${updated.error}`,
      );
    }

    return this.asAuthor(updated.data);
  }

  async getAvatarArtifact(authorId: string) {
    const artifacts = await this.artifactService.findByResourceAndKind(
      'author',
      authorId,
      'avatar',
    );
    if (artifacts.length === 0) return null;
    return this.artifactService.downloadArtifact(artifacts[0].id);
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
