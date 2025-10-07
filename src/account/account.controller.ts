import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthRequest } from '../common/types/interfaces';
import { AccountService } from './account.service';
import { UpdateAccountDto } from './dto/update-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { AccountSwagger } from './account.swagger';
import { LoggerService } from '../common/services/logger.service';
import Account from './entities/account.entity';

@Controller('account')
@UseGuards(AuthGuard)
@AccountSwagger.Controller()
export class AccountController {
  private readonly logger: LoggerService;

  constructor(
    private readonly accountService: AccountService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AccountController');
    this.logger.debug('AccountController initialized');
  }

  @Get()
  @AccountSwagger.GetAccount()
  async get(@Req() req: AuthRequest): Promise<Account> {
    return this.accountService.get(req.account.id);
  }

  @Patch()
  @AccountSwagger.UpdateAccount()
  async update(
    @Body() updateAccountDto: UpdateAccountDto,
    @Req() req: AuthRequest,
  ): Promise<Account> {
    return this.accountService.update(req.account.id, updateAccountDto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @AccountSwagger.DeleteAccount()
  async delete(
    @Body() deleteAccountDto: DeleteAccountDto,
    @Req() req: AuthRequest,
  ): Promise<null> {
    return this.accountService.delete(req.account.id, deleteAccountDto);
  }
}
