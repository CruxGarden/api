import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { HomeService } from './home.service';
import { CreateHomeDto } from './dto/create-home.dto';
import { UpdateHomeDto } from './dto/update-home.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthRequest } from '../common/types/interfaces';
import { DbService } from '../common/services/db.service';
import { HomeSwagger } from './home.swagger';
import { LoggerService } from '../common/services/logger.service';
import Home from './entities/home.entity';
import HomeRaw from './entities/home-raw.entity';

@Controller('homes')
@UseGuards(AuthGuard, AdminGuard)
@HomeSwagger.Controller()
export class HomeController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly homeService: HomeService,
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('HomeController');
  }

  @Get()
  @HomeSwagger.GetAll()
  async getAll(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Home[]> {
    const query = this.homeService.findAllQuery();
    return this.dbService.paginate<HomeRaw, Home>({
      model: Home,
      query,
      request: req,
      response: res,
    }) as Promise<Home[]>;
  }

  @Get(':id')
  @HomeSwagger.GetByKey()
  async getById(@Param('id') id: string): Promise<Home> {
    return this.homeService.findById(id);
  }

  @Post()
  @HomeSwagger.Create()
  async create(@Body() createHomeDto: CreateHomeDto): Promise<Home> {
    return this.homeService.create(createHomeDto);
  }

  @Patch(':id')
  @HomeSwagger.Update()
  async update(
    @Param('id') id: string,
    @Body() updateHomeDto: UpdateHomeDto,
  ): Promise<Home> {
    return this.homeService.update(id, updateHomeDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @HomeSwagger.Delete()
  async delete(@Param('id') id: string): Promise<null> {
    return this.homeService.delete(id);
  }
}
