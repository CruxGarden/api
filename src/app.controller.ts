import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { AppSwagger } from './app.swagger';
import { HealthStatus } from './common/types/interfaces';

@Controller()
@AppSwagger.Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @AppSwagger.Health()
  async health(): Promise<HealthStatus> {
    return this.appService.health();
  }
}
