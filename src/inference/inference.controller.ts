import { IncludedImageService } from './image.service';
import {
  Body,
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiProduces,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AdjustInferenceRequestDto } from './dto/adjust-inference-request.dto';
import {
  InferenceService,
  attributedCrux,
  parseContextTokens,
} from './inference.service';
/** Included paid inference never inherits the nursery's anonymous-account shortcut. */
@Injectable()
export class InferenceAuthGuard extends AuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authorization = context.switchToHttp().getRequest()
      .headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    )
      throw new UnauthorizedException();
    return super.canActivate(context);
  }
}
const CRUX_HEADER = {
  name: 'x-crux-id',
  required: false,
  description:
    'The Crux this request serves, for the usage view only; ignored unless a UUID.',
};
@ApiTags('inference')
@ApiBearerAuth()
@Controller('inference')
@UseGuards(InferenceAuthGuard)
export class InferenceController {
  constructor(
    private readonly inference: InferenceService,
    private readonly images: IncludedImageService,
  ) {}
  @Get('usage')
  @ApiQuery({
    name: 'contextTokens',
    required: false,
    type: Number,
    description:
      'Prompt size of the next request, for nextRequest; defaults to recent requests.',
  })
  usage(
    @Req() req: AuthRequest,
    @Query('contextTokens') contextTokens?: string,
  ) {
    return this.inference.usage(
      req.account.id,
      new Date(),
      parseContextTokens(contextTokens),
    );
  }
  @Post('images')
  @HttpCode(200)
  @ApiHeader(CRUX_HEADER)
  image(
    @Req() req: AuthRequest,
    @Headers('x-request-id') id: string,
    @Headers('x-crux-id') cruxId: string | undefined,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.images.generate(
      req.account.id,
      id,
      body,
      res,
      attributedCrux(cruxId),
    );
  }
  @Post('v1/messages')
  @HttpCode(200)
  @ApiHeader(CRUX_HEADER)
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: 'Anthropic Messages events; tools execute in the client.',
  })
  stream(
    @Req() req: AuthRequest,
    @Headers('x-request-id') id: string,
    @Headers('x-crux-id') cruxId: string | undefined,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.inference.stream(
      req.account.id,
      id,
      body,
      res,
      attributedCrux(cruxId),
    );
  }
}
/** Host operations on the included-inference ledger (ADR 0082). */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/inference')
@UseGuards(InferenceAuthGuard, AdminGuard)
export class InferenceAdminController {
  constructor(private readonly inference: InferenceService) {}
  @Post('requests/:id/adjust')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lower the charge of a settled included request, with a reason',
  })
  adjust(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustInferenceRequestDto,
  ) {
    return this.inference.adjust(
      req.account.id,
      id,
      dto.chargedMicrodollars,
      dto.reason,
    );
  }
}
