import { Module, Global } from '@nestjs/common';
import { EmailService } from './services/email.service';
import { RedisService } from './services/redis.service';
import { StoreService } from './services/store.service';
import { DbService } from './services/db.service';
import { KeyMaster } from './services/key.master';
import { PublishStorageService } from './services/publish-storage.service';

@Global()
@Module({
  providers: [
    DbService,
    EmailService,
    RedisService,
    StoreService,
    PublishStorageService,
    KeyMaster,
  ],
  exports: [
    DbService,
    EmailService,
    RedisService,
    StoreService,
    PublishStorageService,
    KeyMaster,
  ],
})
export class CommonModule {}
