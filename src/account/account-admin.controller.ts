import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AccountService, type AccountAdminView } from './account.service';
import { SuspendAccountDto } from './dto/suspend-account.dto';

/** Host moderation of whole accounts (ADR 0083). Admins only. */
@ApiTags('admin')
@Controller('admin/accounts')
@UseGuards(AuthGuard, AdminGuard)
export class AccountAdminController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  @ApiOperation({ summary: 'Find accounts by email or username' })
  @ApiQuery({ name: 'query', required: false })
  search(@Query('query') query?: string): Promise<AccountAdminView[]> {
    return this.accountService.search(query ?? '');
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Suspend an account: sign-in and reads still work; hosted writes are refused',
  })
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendAccountDto,
    @Req() req: AuthRequest,
  ): Promise<AccountAdminView> {
    return this.accountService.suspend(id, dto.reason, req.account.id);
  }

  @Post(':id/unsuspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift an account suspension' })
  unsuspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ): Promise<AccountAdminView> {
    return this.accountService.unsuspend(id, req.account.id);
  }
}
