import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { CruxRepository } from './crux.repository';
import { KeyMaster } from '../common/services/key.master';
import { DimensionService } from '../dimension/dimension.service';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateCruxDto } from './dto/create-crux.dto';
import { UpdateCruxDto } from './dto/update-crux.dto';
import { CreateDimensionDto } from '../dimension/dto/create-dimension.dto';
import { UpdateDimensionDto } from '../dimension/dto/update-dimension.dto';
import {
  CruxStatus,
  CruxType,
  CruxVisibility,
  DimensionType,
} from '../common/types/enums';
import Crux from './entities/crux.entity';
import CruxRaw from './entities/crux-raw.entity';
import Dimension from '../dimension/entities/dimension.entity';
import DimensionRaw from '../dimension/entities/dimension-raw.entity';

/**
 * The API's graph operations, independent of hosted publishing infrastructure.
 * CruxService inherits these operations and retains publication-ingest policy.
 * Desktop lifecycle/file/Task orchestration has not moved here yet.
 */
@Injectable()
export class CruxGraphService {
  protected readonly protectedMetaKeys: string[] = [];
  constructor(
    protected readonly cruxRepository: CruxRepository,
    protected readonly keyMaster: KeyMaster,
    protected readonly dimensionService: DimensionService,
  ) {}

  asCrux(data: CruxRaw): Crux {
    const entityFields = toEntityFields(data);
    return new Crux(entityFields);
  }

  asCruxes(rows: CruxRaw[]): Crux[] {
    return rows.map((data) => this.asCrux(data));
  }

  findAllByAuthorQuery(
    authorId: string,
  ): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.cruxRepository.findAllByAuthorQuery(authorId);
  }

  findPublicByAuthorQuery(
    authorId: string,
    kind?: 'tool' | 'mood' | 'creations',
  ): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.cruxRepository.findPublicByAuthorQuery(authorId, kind);
  }

  async findById(id: string): Promise<Crux> {
    const { data, error } = await this.cruxRepository.findBy('id', id);

    if (error)
      throw new InternalServerErrorException('Could not load Crux', {
        cause: error,
      });
    if (!data) {
      throw new NotFoundException('Crux not found');
    }

    return this.asCrux(data);
  }

  async findByAuthorAndSlug(authorId: string, slug: string): Promise<Crux> {
    const { data, error } = await this.cruxRepository.findByAuthorAndSlug(
      authorId,
      slug,
    );

    if (error)
      throw new InternalServerErrorException('Could not load Crux', {
        cause: error,
      });
    if (!data) {
      throw new NotFoundException('Crux not found');
    }

    return this.asCrux(data);
  }

  /** Working data is available only to its author, even when the Crux is public. */
  async findOwnedById(id: string, authorId: string): Promise<Crux> {
    const crux = await this.findById(id);
    if (crux.authorId !== authorId) {
      throw new ForbiddenException(
        'You do not have permission to access this crux',
      );
    }
    return crux;
  }

  async findOwnedByIdentifier(
    identifier: string,
    authorId: string,
  ): Promise<Crux> {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identifier,
      );
    return isUuid
      ? this.findOwnedById(identifier, authorId)
      : this.findByAuthorAndSlug(authorId, identifier);
  }

  /** Create new private work. Never replace existing work as a side effect. */
  async create(input: CreateCruxDto): Promise<Crux> {
    const dto: CreateCruxDto = {
      ...input,
      id: input.id || this.keyMaster.generateId(),
      data: input.data ?? '',
      type: input.type || CruxType.MARKDOWN,
      status: input.status || CruxStatus.LIVING,
      visibility: input.visibility || CruxVisibility.PRIVATE,
      discoverable: input.discoverable ?? false,
    };
    const existingId = await this.cruxRepository.findByIdIncludingDeleted(
      dto.id,
    );
    if (existingId.error)
      throw new InternalServerErrorException('Could not check Crux identity', {
        cause: existingId.error,
      });
    if (existingId.data)
      throw new ConflictException('A Crux with this identity already exists');
    const existingSlug = await this.cruxRepository.findByAuthorAndSlug(
      dto.authorId,
      dto.slug,
    );
    if (existingSlug.error)
      throw new InternalServerErrorException('Could not check Crux slug', {
        cause: existingSlug.error,
      });
    if (existingSlug.data)
      throw new ConflictException(`Slug "${dto.slug}" is already in use`);
    const result = await this.cruxRepository.create(dto);
    if (result.error) {
      // A concurrent insert (or the desktop's stricter global slug index) can
      // win after the checks. A collision never falls back to replacement.
      const code = (result.error as Error & { code?: string }).code;
      if (
        [
          '23505',
          'SQLITE_CONSTRAINT_UNIQUE',
          'SQLITE_CONSTRAINT_PRIMARYKEY',
        ].includes(code)
      ) {
        throw new ConflictException(
          'A Crux with this identity or slug already exists',
        );
      }
      throw new InternalServerErrorException('Could not create Crux', {
        cause: result.error,
      });
    }
    return this.asCrux(result.data);
  }

  async update(cruxId: string, updateCruxDto: UpdateCruxDto): Promise<Crux> {
    // 1) fetch crux
    const cruxToUpdate = await this.findById(cruxId);

    // 2) check slug uniqueness (per author, excluding this crux)
    if (updateCruxDto.slug && updateCruxDto.slug !== cruxToUpdate.slug) {
      const existing = await this.cruxRepository.findByAuthorAndSlug(
        cruxToUpdate.authorId,
        updateCruxDto.slug,
      );
      if (existing.error)
        throw new InternalServerErrorException('Could not check Crux slug', {
          cause: existing.error,
        });
      if (existing.data) {
        throw new ConflictException(
          `Slug "${updateCruxDto.slug}" is already in use`,
        );
      }
    }

    // 3) update crux
    const updated = await this.cruxRepository.update(
      cruxToUpdate.id,
      updateCruxDto,
      ...(this.protectedMetaKeys.length ? [this.protectedMetaKeys] : []),
    );
    if (updated.error) {
      throw new InternalServerErrorException('Crux update error', {
        cause: updated.error,
      });
    }

    return this.asCrux(updated.data);
  }

  /* crux dimensions */

  getDimensionsQuery(
    sourceCruxId: string,
    dimensionType?: DimensionType,
    embedSource = false,
    embedTarget = true,
  ): Knex.QueryBuilder<DimensionRaw, DimensionRaw[]> {
    return this.dimensionService.findBySourceIdAndTypeQuery(
      sourceCruxId,
      dimensionType,
      embedSource,
      embedTarget,
    );
  }

  async createDimension(
    cruxId: string,
    createDimensionDto: CreateDimensionDto,
  ): Promise<Dimension> {
    const sourceCrux = await this.findById(cruxId);
    if (!sourceCrux) {
      throw new NotFoundException('Crux not found');
    }
    createDimensionDto.sourceId = sourceCrux.id;
    return this.dimensionService.create(createDimensionDto);
  }

  async updateDimension(
    dimensionId: string,
    updateDimensionDto: UpdateDimensionDto,
  ): Promise<Dimension> {
    return this.dimensionService.update(dimensionId, updateDimensionDto);
  }

  /* ~crux dimensions */
}
