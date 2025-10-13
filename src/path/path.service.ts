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

  async findByKey(key: string): Promise<Path> {
    const { data, error } = await this.pathRepository.findBy('key', key);

    if (error || !data) {
      throw new NotFoundException('Path not found');
    }

    return this.asPath(data);
  }

  async create(createPathDto: CreatePathDto): Promise<Path> {
    createPathDto.id = this.keyMaster.generateId();
    createPathDto.key = this.keyMaster.generateKey();

    this.applyDefaults(createPathDto);

    const created = await this.pathRepository.create(createPathDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Path creation error: ${created.error}`,
      );

    return this.asPath(created.data);
  }

  async update(pathKey: string, updatePathDto: UpdatePathDto): Promise<Path> {
    // 1) fetch path
    const pathToUpdate = await this.findByKey(pathKey);

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

  async delete(pathKey: string): Promise<null> {
    // 1) fetch path
    const pathToDelete = await this.findByKey(pathKey);
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

  async getMarkers(pathKey: string): Promise<Marker[]> {
    const path = await this.findByKey(pathKey);
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
    pathKey: string,
    markers: MarkerInput[],
    authorId: string,
  ): Promise<Marker[]> {
    const path = await this.findByKey(pathKey);
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
      const crux = await this.cruxService.findByKey(markerInput.cruxKey);
      if (!crux) {
        throw new NotFoundException(`Crux not found: ${markerInput.cruxKey}`);
      }

      const markerDto: CreateMarkerDto = {
        id: this.keyMaster.generateId(),
        key: this.keyMaster.generateKey(),
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

  async getTags(pathKey: string, filter?: string): Promise<Tag[]> {
    return this.tagService.getTags(ResourceType.PATH, pathKey, filter);
  }

  async syncTags(
    pathKey: string,
    labels: string[],
    authorId: string,
  ): Promise<Tag[]> {
    return this.tagService.syncTags(
      ResourceType.PATH,
      pathKey,
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
