import { BillingOperationsService } from './operations.service';
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
  Optional,
  ServiceUnavailableException,
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
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import { isAdmin } from '../common/helpers/role-helpers';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { BillingService } from './billing.service';
import {
  SIMULATION_ACTIONS,
  type SimulationAction,
} from './simulation.provider';
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

export class RecoverCheckoutDto {
  @ApiProperty()
  @IsUUID()
  accountId!: string;

  @ApiProperty({
    description: 'Session identified in the payment provider dashboard',
  })
  @IsString()
  @Matches(/^cs_[A-Za-z0-9_]+$/)
  @MaxLength(255)
  sessionId!: string;
}

export class ResolveAbsentCheckoutDto {
  @ApiProperty()
  @IsUUID()
  accountId!: string;
  @ApiProperty()
  @IsUUID()
  attemptId!: string;
  @ApiProperty({
    description:
      'Provider request-log or support-case reference; never include credentials',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9:/._#-]{1,255}$/)
  reviewReference!: string;
  @ApiProperty({ enum: ['provider-reviewed-no-checkout-or-subscription'] })
  @IsIn(['provider-reviewed-no-checkout-or-subscription'])
  confirmation!: string;
}

export class ReconcileDto {
  @ApiProperty()
  @IsUUID()
  accountId!: string;
}

export class SimulationDto {
  @ApiProperty({ enum: SIMULATION_ACTIONS })
  @IsIn(SIMULATION_ACTIONS)
  action!: SimulationAction;

  @ApiProperty({ required: false, enum: ['gardener', 'gardener_plus'] })
  @IsOptional()
  @IsIn(['gardener', 'gardener_plus'])
  planId?: string;

  @ApiProperty({ required: false, enum: ['month', 'year'] })
  @IsOptional()
  @IsIn(['month', 'year'])
  interval?: 'month' | 'year';
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    @Optional() private readonly operations?: BillingOperationsService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'Plans and prices (public)' })
  plans() {
    return this.billing.catalog();
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'This account’s plan and subscription state' })
  async me(@Req() req: AuthRequest) {
    return this.withCapabilities(await this.billing.me(req.account.id), req);
  }

  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a hosted checkout; returns the URL to open' })
  checkout(@Body() dto: CheckoutDto, @Req() req: AuthRequest) {
    return this.billing.checkout(req.account.id, dto.planId, dto.interval);
  }

  @Post('checkout/resume')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume the existing checkout without creating another',
  })
  resumeCheckout(@Req() req: AuthRequest) {
    return this.billing.resumeCheckout(req.account.id);
  }

  @Post('checkout/cancel')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Expire pending checkout; an already completed payment is synchronized',
  })
  async cancelCheckout(@Req() req: AuthRequest) {
    return this.withCapabilities(
      await this.billing.cancelCheckout(req.account.id),
      req,
    );
  }

  @Post('checkout/recover')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin: recover an ambiguous checkout using verified provider metadata',
  })
  recoverCheckout(@Body() dto: RecoverCheckoutDto, @Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    return this.billing.recoverCheckout(dto.accountId, dto.sessionId);
  }

  @Post('checkout/resolve-absent')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin: audit provider-confirmed absence before releasing an old ambiguous checkout',
  })
  resolveAbsentCheckout(
    @Body() dto: ResolveAbsentCheckoutDto,
    @Req() req: AuthRequest,
  ) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    return this.billing.resolveAbsentCheckout(
      dto.accountId,
      dto.attemptId,
      req.account.id,
      dto.reviewReference,
    );
  }

  @Get('operations')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary:
      'Admin: billing configuration, queue health and recovery identifiers',
  })
  operationsHealth(@Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    if (!this.operations)
      throw new ServiceUnavailableException(
        'Billing monitoring is unavailable',
      );
    return this.operations.health();
  }

  @Post('operations/reconcile')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: retry provider reconciliation for one account',
  })
  reconcile(@Body() dto: ReconcileDto, @Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    if (!this.operations)
      throw new ServiceUnavailableException(
        'Billing monitoring is unavailable',
      );
    return this.operations.reconcile(dto.accountId, true);
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

  @Get('invoices')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'This account’s most recent invoices (at most 24), newest first',
  })
  invoices(@Req() req: AuthRequest) {
    return this.billing.invoices(req.account.id);
  }

  @Post('sync')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-pull the subscription from the provider (after checkout)',
  })
  async sync(@Req() req: AuthRequest) {
    return this.withCapabilities(await this.billing.sync(req.account.id), req);
  }

  @Post('simulation')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Operator: simulate billing for your own account (simulation provider only)',
  })
  async simulate(@Body() dto: SimulationDto, @Req() req: AuthRequest) {
    if (!isAdmin(req.account.role)) throw new ForbiddenException('Admins only');
    return this.withCapabilities(
      await this.billing.simulate(
        req.account.id,
        dto.action,
        dto.planId,
        dto.interval,
      ),
      req,
    );
  }

  private withCapabilities<T>(state: T, req: AuthRequest) {
    return {
      ...state,
      canSimulate:
        this.billing.providerName === 'simulation' && isAdmin(req.account.role),
      canMonitor: !!this.operations && isAdmin(req.account.role),
    };
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
