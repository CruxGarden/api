import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { PathRepository } from './path.repository';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { CreateMarkerDto } from './dto/create-marker.dto';
import { MarkerInput } from './dto/sync-markers.dto';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { TagService } from '../tag/tag.service';
import { CruxService } from '../crux/crux.service';
import { HomeService } from '../home/home.service';
import { PathType, PathVisibility, ResourceType } from '../common/types/enums';
import PathRaw from './entities/path-raw.entity';
import Path from './entities/path.entity';
import MarkerRaw from './entities/marker-raw.entity';
import Marker from './entities/marker.entity';
import Tag from '../tag/entities/tag.entity';

@Injectable()
export class PathService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly pathRepository: PathRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly tagService: TagService,
    private readonly cruxService: CruxService,
    private readonly homeService: HomeService,
  ) {
    this.logger = this.loggerService.createChildLogger('PathService');
  }

  asPath(data: PathRaw): Path {
    const entityFields = toEntityFields(data);
    return new Path(entityFields);
  }

  asPaths(rows: PathRaw[]): Path[] {
    return rows.map((data) => this.asPath(data));
  }

  findAllQuery(): Knex.QueryBuilder<PathRaw, PathRaw[]> {
    return this.pathRepository.findAllQuery();
  }

  async findById(id: string): Promise<Path> {
    const { data, error } = await this.pathRepository.findBy('id', id);

    if (error || !data) {
      throw new NotFoundException('Path not found');
    }

    return this.asPath(data);
  }

  async findBySlug(slug: string): Promise<Path> {
    const { data, error } = await this.pathRepository.findBy('slug', slug);

    if (error || !data) {
      throw new NotFoundException('Path not found');
    }

    return this.asPath(data);
  }

  async findByIdentifier(identifier: string): Promise<Path> {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(identifier)) {
      return this.findById(identifier);
    }

    return this.findBySlug(identifier);
  }

  async create(createPathDto: CreatePathDto): Promise<Path> {
    createPathDto.id = this.keyMaster.generateId();

    this.applyDefaults(createPathDto);

    const created = await this.pathRepository.create(createPathDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Path creation error: ${created.error}`,
      );

    return this.asPath(created.data);
  }

  async update(pathId: string, updatePathDto: UpdatePathDto): Promise<Path> {
    // 1) fetch path
    const pathToUpdate = await this.findById(pathId);

    // 2) update path
    const updated = await this.pathRepository.update(
      pathToUpdate.id,
      updatePathDto,
    );
    if (updated.error) {
      throw new InternalServerErrorException(
        `Path update error: ${updated.error}`,
      );
    }

    return this.asPath(updated.data);
  }

  async delete(pathId: string): Promise<null> {
    // 1) fetch path
    const pathToDelete = await this.findById(pathId);
    if (!pathToDelete) throw new NotFoundException('Path not found');

    // 2) delete path
    const { error: deleteError } = await this.pathRepository.delete(
      pathToDelete.id,
    );

    if (deleteError) {
      throw new InternalServerErrorException(
        `Path deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  /* path markers */

  asMarker(data: MarkerRaw): Marker {
    const entityFields = toEntityFields(data);
    return new Marker(entityFields);
  }

  asMarkers(rows: MarkerRaw[]): Marker[] {
    return rows.map((data) => this.asMarker(data));
  }

  async getMarkers(pathId: string): Promise<Marker[]> {
    const path = await this.findById(pathId);
    const { data, error } = await this.pathRepository.findMarkersByPathId(
      path.id,
    );

    if (error) {
      throw new InternalServerErrorException(
        `Error fetching markers: ${error}`,
      );
    }

    return this.asMarkers(data || []);
  }

  async syncMarkers(
    pathId: string,
    markers: MarkerInput[],
    authorId: string,
  ): Promise<Marker[]> {
    const path = await this.findById(pathId);
    const home = await this.homeService.primary();

    // 1) Delete all existing markers for this path
    const { error: deleteError } =
      await this.pathRepository.deleteMarkersByPathId(path.id);
    if (deleteError) {
      throw new InternalServerErrorException(
        `Error deleting markers: ${deleteError}`,
      );
    }

    // 2) Create new markers
    const createdMarkers: Marker[] = [];
    for (const markerInput of markers) {
      // Verify crux exists
      const crux = await this.cruxService.findById(markerInput.cruxId);
      if (!crux) {
        throw new NotFoundException(`Crux not found: ${markerInput.cruxId}`);
      }

      const markerDto: CreateMarkerDto = {
        id: this.keyMaster.generateId(),
        pathId: path.id,
        cruxId: crux.id,
        order: markerInput.order,
        note: markerInput.note,
        authorId,
        homeId: home.id,
      };

      const { data, error } = await this.pathRepository.createMarker(markerDto);
      if (error) {
        throw new InternalServerErrorException(
          `Error creating marker: ${error}`,
        );
      }

      createdMarkers.push(this.asMarker(data));
    }

    return createdMarkers;
  }

  /* ~path markers */

  /* path tags */

  async getTags(pathId: string, filter?: string): Promise<Tag[]> {
    return this.tagService.getTags(ResourceType.PATH, pathId, filter);
  }

  async syncTags(
    pathId: string,
    labels: string[],
    authorId: string,
  ): Promise<Tag[]> {
    return this.tagService.syncTags(
      ResourceType.PATH,
      pathId,
      labels,
      authorId,
    );
  }

  /* ~path tags */

  private applyDefaults(dto: CreatePathDto): void {
    if (!dto.type) dto.type = PathType.LIVING;
    if (!dto.visibility) dto.visibility = PathVisibility.UNLISTED;
  }
}
