import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { toEntityFields } from '../common/helpers/case-helpers';
import { PathRepository } from './path.repository';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { MarkerInput } from './dto/sync-markers.dto';
import { KeyMaster } from '../common/services/key.master';
import { TagService } from '../tag/tag.service';
import { CruxService } from '../crux/crux.service';
import { HomeService } from '../home/home.service';
import { PathType, PathVisibility, ResourceType } from '../common/types/enums';
import Path from './entities/path.entity';
import Marker from './entities/marker.entity';

@Injectable()
export class PathService {
  constructor(
    private readonly pathRepository: PathRepository,
    private readonly keyMaster: KeyMaster,
    private readonly tagService: TagService,
    private readonly cruxService: CruxService,
    private readonly homeService: HomeService,
  ) {}

  findAllQuery(authorId: string) {
    return this.pathRepository.findAllQuery(authorId);
  }

  async findOwnedById(id: string, authorId: string): Promise<Path> {
    const { data, error } = await this.pathRepository.findBy('id', id);
    if (error)
      throw new InternalServerErrorException('Could not load Path', {
        cause: error,
      });
    if (!data) throw new NotFoundException('Path not found');
    if (data.author_id !== authorId)
      throw new ForbiddenException('You do not own this Path');
    return new Path(toEntityFields(data));
  }

  async findOwnedByIdentifier(
    identifier: string,
    authorId: string,
  ): Promise<Path> {
    if (isUUID(identifier)) return this.findOwnedById(identifier, authorId);
    const { data, error } = await this.pathRepository.findBy(
      'slug',
      identifier,
      authorId,
    );
    if (error)
      throw new InternalServerErrorException('Could not load Path', {
        cause: error,
      });
    if (!data) throw new NotFoundException('Path not found');
    return new Path(toEntityFields(data));
  }

  async create(dto: CreatePathDto, authorId: string): Promise<Path> {
    const home = await this.homeService.primary();
    const result = await this.pathRepository.create({
      ...dto,
      id: this.keyMaster.generateId(),
      authorId,
      homeId: home.id,
      type: dto.type ?? PathType.LIVING,
      visibility: dto.visibility ?? PathVisibility.UNLISTED,
    });
    if (result.error)
      throw new InternalServerErrorException('Could not create Path', {
        cause: result.error,
      });
    if (!result.data)
      throw new InternalServerErrorException(
        'Path creation returned no record',
      );
    return new Path(toEntityFields(result.data));
  }

  async update(
    id: string,
    dto: UpdatePathDto,
    authorId: string,
  ): Promise<Path> {
    await this.findOwnedById(id, authorId);
    if (dto.entry != null) {
      const markers = await this.getMarkers(id, authorId);
      if (!markers.some((marker) => marker.id === dto.entry))
        throw new BadRequestException(
          'Entry must be a live marker in this Path',
        );
    }
    const result = await this.pathRepository.update(id, authorId, dto);
    if (result.error)
      throw new InternalServerErrorException('Could not update Path', {
        cause: result.error,
      });
    if (!result.data) throw new NotFoundException('Path not found');
    return new Path(toEntityFields(result.data));
  }

  async delete(id: string, authorId: string): Promise<null> {
    await this.findOwnedById(id, authorId);
    const result = await this.pathRepository.delete(id, authorId);
    if (result.error)
      throw new InternalServerErrorException('Could not delete Path', {
        cause: result.error,
      });
    return null;
  }

  async getMarkers(pathId: string, authorId: string): Promise<Marker[]> {
    await this.findOwnedById(pathId, authorId);
    const result = await this.pathRepository.findMarkersByPathId(
      pathId,
      authorId,
    );
    if (result.error)
      throw new InternalServerErrorException('Could not load markers', {
        cause: result.error,
      });
    return result.data.map((row) => new Marker(toEntityFields(row)));
  }

  async syncMarkers(
    pathId: string,
    markers: MarkerInput[],
    authorId: string,
  ): Promise<Marker[]> {
    await this.findOwnedById(pathId, authorId);
    if (
      markers.length > 1000 ||
      new Set(markers.map((marker) => marker.order)).size !== markers.length
    )
      throw new BadRequestException(
        'Use at most 1000 markers with distinct positions',
      );
    // Validate every target before asking the repository to replace any records.
    for (const cruxId of new Set(markers.map((marker) => marker.cruxId))) {
      await this.cruxService.findOwnedById(cruxId, authorId);
    }
    const records = [...markers]
      .sort((a, b) => a.order - b.order)
      .map((marker) => ({ ...marker, id: this.keyMaster.generateId() }));
    const result = await this.pathRepository.replaceMarkers(
      pathId,
      authorId,
      records,
    );
    if (result.error)
      throw new InternalServerErrorException('Could not replace markers', {
        cause: result.error,
      });
    return result.data.map((row) => new Marker(toEntityFields(row)));
  }

  async getTags(pathId: string, authorId: string, filter?: string) {
    await this.findOwnedById(pathId, authorId);
    return this.tagService.getTags(ResourceType.PATH, pathId, filter);
  }

  async syncTags(pathId: string, labels: string[], authorId: string) {
    await this.findOwnedById(pathId, authorId);
    return this.tagService.syncTags(
      ResourceType.PATH,
      pathId,
      labels,
      authorId,
    );
  }
}
