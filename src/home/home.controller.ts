import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  ForbiddenException,
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
import { AccountRole } from '../common/types/enums';
import { AuthRequest } from '../common/types/interfaces';
import { DbService } from '../common/services/db.service';
import { HomeSwagger } from './home.swagger';
import { LoggerService } from '../common/services/logger.service';
import Home from './entities/home.entity';
import HomeRaw from './entities/home-raw.entity';

@Controller('homes')
@UseGuards(AuthGuard)
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

  private ensureAdmin(req: AuthRequest): void {
    if (req.account.role !== AccountRole.ADMIN) {
      throw new ForbiddenException('Only admins can manage homes');
    }
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

  @Get(':homeKey')
  @HomeSwagger.GetByKey()
  async getByKey(@Param('homeKey') homeKey: string): Promise<Home> {
    return this.homeService.findByKey(homeKey);
  }

  @Post()
  @HomeSwagger.Create()
  async create(
    @Body() createHomeDto: CreateHomeDto,
    @Req() req: AuthRequest,
  ): Promise<Home> {
    this.ensureAdmin(req);
    return this.homeService.create(createHomeDto);
  }

  @Patch(':homeKey')
  @HomeSwagger.Update()
  async update(
    @Param('homeKey') homeKey: string,
    @Body() updateHomeDto: UpdateHomeDto,
    @Req() req: AuthRequest,
  ): Promise<Home> {
    this.ensureAdmin(req);
    return this.homeService.update(homeKey, updateHomeDto);
  }

  @Delete(':homeKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @HomeSwagger.Delete()
  async delete(
    @Param('homeKey') homeKey: string,
    @Req() req: AuthRequest,
  ): Promise<null> {
    this.ensureAdmin(req);
    return this.homeService.delete(homeKey);
  }
}
