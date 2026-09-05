import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
  ApiProperty,
} from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import { isAdmin } from '../common/helpers/role-helpers';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { BillingService } from './billing.service';
import { PLAN_ORDER } from '../usage/plans';

export class CheckoutDto {
  @ApiProperty({
    description: 'A paid plan id',
    enum: PLAN_ORDER.filter((p) => p !== 'free'),
  })
  @IsString()
  @IsIn(PLAN_ORDER.filter((p) => p !== 'free'))
  planId!: string;

  @ApiProperty({ enum: ['month', 'year'] })
  @IsString()
  @IsIn(['month', 'year'])
  interval!: 'month' | 'year';
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'Plans and prices (public)' })
  plans() {
    return this.billing.catalog();
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'This account’s plan and subscription state' })
  me(@Req() req: AuthRequest) {
    return this.billing.me(req.account.id);
  }

  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a hosted checkout; returns the URL to open' })
  checkout(@Body() dto: CheckoutDto, @Req() req: AuthRequest) {
    return this.billing.checkout(req.account.id, dto.planId, dto.interval);
  }

  @Post('portal')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Customer portal URL (change plan, payment method, cancel)',
  })
  portal(@Req() req: AuthRequest) {
    return this.billing.portal(req.account.id);
  }

  @Post('sync')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-pull the subscription from the provider (after checkout)',
  })
  sync(@Req() req: AuthRequest) {
    return this.billing.sync(req.account.id);
  }

  @Post('webhook/stripe')
  @SkipThrottle() // Stripe bursts on retries; the signature is the auth
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  webhook(
    @Req() req: AuthRequest & { rawBody?: Buffer },
    @Headers('stripe-signature') sig?: string,
  ) {
    if (!req.rawBody) throw new BadRequestException('Raw body unavailable');
    return this.billing.handleWebhook(req.rawBody, sig);
  }

  @Get('subscriptions')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Admin: all subscriptions' })
  async all(@Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    return this.billing.listAll();
  }
}
