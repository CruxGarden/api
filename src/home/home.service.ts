import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateHomeDto } from './dto/create-home.dto';
import { UpdateHomeDto } from './dto/update-home.dto';
import { HomeRepository } from './home.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import HomeRaw from './entities/home-raw.entity';
import Home from './entities/home.entity';

@Injectable()
export class HomeService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly homeRepository: HomeRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('HomeService');
  }

  asHome(data: HomeRaw): Home {
    const entityFields = toEntityFields(data);
    return new Home(entityFields);
  }

  asHomes(rows: HomeRaw[]): Home[] {
    return rows.map((data) => this.asHome(data));
  }

  findAllQuery(): Knex.QueryBuilder<HomeRaw, HomeRaw[]> {
    return this.homeRepository.findAllQuery();
  }

  async findById(id: string): Promise<Home> {
    const { data: home, error } = await this.homeRepository.findBy('id', id);

    if (error || !home) {
      throw new NotFoundException('Home not found');
    }

    return this.asHome(home);
  }

  async findByKey(key: string): Promise<Home> {
    const { data: home, error } = await this.homeRepository.findBy('key', key);

    if (error || !home) {
      throw new NotFoundException('Home not found');
    }

    return this.asHome(home);
  }

  async create(createHomeDto: CreateHomeDto): Promise<Home> {
    createHomeDto.id = this.keyMaster.generateId();
    createHomeDto.key = this.keyMaster.generateKey();

    const created = await this.homeRepository.create(createHomeDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Home creation error: ${created.error}`,
      );

    return this.asHome(created.data);
  }

  async update(homeKey: string, updateDto: UpdateHomeDto): Promise<Home> {
    // 1) fetch home
    const homeToUpdate = await this.findByKey(homeKey);

    // 2) update home
    const updated = await this.homeRepository.update(
      homeToUpdate.id,
      updateDto,
    );
    if (updated.error)
      throw new InternalServerErrorException(
        `Home update error: ${updated.error}`,
      );

    return this.asHome(updated.data);
  }

  async delete(homeKey: string): Promise<null> {
    const homeToDelete = await this.findByKey(homeKey);
    if (!homeToDelete) throw new NotFoundException('Home not found');

    const { error: deleteError } = await this.homeRepository.delete(
      homeToDelete.id,
    );
    if (deleteError) {
      throw new InternalServerErrorException(
        `Home deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  async primary(): Promise<Home> {
    const { data: home, error } = await this.homeRepository.findBy(
      'primary',
      true,
    );

    if (error || !home) {
      throw new NotFoundException('Primary home not found');
    }

    return this.asHome(home);
  }
}
