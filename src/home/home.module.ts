import { Module } from '@nestjs/common';
import { HomeService } from './home.service';
import { HomeController } from './home.controller';
import { HomeRepository } from './home.repository';

@Module({
  imports: [],
  controllers: [HomeController],
  providers: [HomeService, HomeRepository],
  exports: [HomeService],
})
export class HomeModule {}
