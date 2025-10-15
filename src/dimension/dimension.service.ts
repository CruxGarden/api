import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { DimensionRepository } from './dimension.repository';
import { CreateDimensionDto } from './dto/create-dimension.dto';
import { UpdateDimensionDto } from './dto/update-dimension.dto';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { toEntityFields } from '../common/helpers/case-helpers';
import Dimension from './entities/dimension.entity';
import DimensionRaw from './entities/dimension-raw.entity';
import { DimensionType } from 'src/common';

@Injectable()
export class DimensionService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dimensionRepository: DimensionRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('DimensionService');
  }

  asDimension(data: DimensionRaw): Dimension {
    const entityFields = toEntityFields(data);
    return new Dimension(entityFields);
  }

  asDimensions(rows: DimensionRaw[]): Dimension[] {
    return rows.map((data) => this.asDimension(data));
  }

  findBySourceIdAndTypeQuery(
    sourceId: string,
    type?: DimensionType,
    embedSource = false,
    embedTarget = true,
  ): Knex.QueryBuilder<DimensionRaw, DimensionRaw[]> {
    return this.dimensionRepository.findBySourceIdAndTypeQuery(
      sourceId,
      type,
      embedSource,
      embedTarget,
    );
  }

  async findById(id: string): Promise<Dimension> {
    const { data, error } = await this.dimensionRepository.findBy('id', id);

    if (error || !data) {
      throw new NotFoundException('Dimension not found');
    }

    return this.asDimension(data);
  }

  async findByKey(key: string): Promise<Dimension> {
    const { data, error } = await this.dimensionRepository.findBy('key', key);

    if (error || !data) {
      throw new NotFoundException('Dimension not found');
    }

    return this.asDimension(data);
  }

  async create(createDimensionDto: CreateDimensionDto): Promise<Dimension> {
    createDimensionDto.id = this.keyMaster.generateId();
    createDimensionDto.key = this.keyMaster.generateKey();

    const created = await this.dimensionRepository.create(createDimensionDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Dimension creation error: ${created.error}`,
      );

    return this.asDimension(created.data);
  }

  async update(
    dimensionKey: string,
    updateDimensionDto: UpdateDimensionDto,
  ): Promise<Dimension> {
    const dimensionToUpdate = await this.findByKey(dimensionKey);

    const updated = await this.dimensionRepository.update(
      dimensionToUpdate.id,
      updateDimensionDto,
    );
    if (updated.error) {
      throw new InternalServerErrorException(
        `Dimension update error: ${updated.error}`,
      );
    }
    return this.asDimension(updated.data);
  }

  async delete(dimensionKey: string): Promise<null> {
    const dimensionToDelete = await this.findByKey(dimensionKey);

    const { error: deleteError } = await this.dimensionRepository.delete(
      dimensionToDelete.id,
    );

    if (deleteError) {
      throw new InternalServerErrorException(
        `Dimension deletion error: ${deleteError}`,
      );
    }

    return null;
  }
}
