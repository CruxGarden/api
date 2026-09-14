import {
  Body,
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiProduces,
  ApiOkResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { InferenceService } from './inference.service';
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
@ApiTags('inference')
@ApiBearerAuth()
@Controller('inference')
@UseGuards(InferenceAuthGuard)
export class InferenceController {
  constructor(private readonly inference: InferenceService) {}
  @Get('usage') usage(@Req() req: AuthRequest) {
    return this.inference.usage(req.account.id);
  }
  @Post('v1/messages')
  @HttpCode(200)
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: 'Anthropic Messages events; tools execute in the client.',
  })
  stream(
    @Req() req: AuthRequest,
    @Headers('x-request-id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.inference.stream(req.account.id, id, body, res);
  }
}
