import { Module, Global } from '@nestjs/common';
import { EmailService } from './services/email.service';
import { RedisService } from './services/redis.service';
import { StoreService } from './services/store.service';
import { DbService } from './services/db.service';
import { KeyMaster } from './services/key.master';

@Global()
@Module({
  providers: [DbService, EmailService, RedisService, StoreService, KeyMaster],
  exports: [DbService, EmailService, RedisService, StoreService, KeyMaster],
})
export class CommonModule {}
