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
  Query,
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
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly accountService: AccountService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AccountController');
  }

  @Get('check-email')
  @AccountSwagger.CheckEmail()
  async checkEmail(
    @Query('email') email: string,
    @Req() req: AuthRequest,
  ): Promise<{ available: boolean }> {
    const existingAccount = await this.accountService.findByEmail(email);
    // Email is available if not found, or if it belongs to the current user
    const available = !existingAccount || existingAccount.id === req.account.id;
    return { available };
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
