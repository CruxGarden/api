import { Module, Global } from '@nestjs/common';
import { EmailService } from './services/email.service';
import { RedisService } from './services/redis.service';
import { DbService } from './services/db.service';
import { KeyMaster } from './services/key.master';

@Global()
@Module({
  providers: [DbService, EmailService, RedisService, KeyMaster],
  exports: [DbService, EmailService, RedisService, KeyMaster],
})
export class CommonModule {}
