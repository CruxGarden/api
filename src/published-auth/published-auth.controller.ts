import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { AuthCodeDto } from '../auth/dto/auth-code.dto';
import { AuthLoginDto } from '../auth/dto/auth-login.dto';
import { AuthTokenDto } from '../auth/dto/auth-token.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { PublishedAuthService } from './published-auth.service';
import { AccountOriginGuard } from '../common/guards/account-origin.guard';

class InheritDto {
  @IsString() @MaxLength(2048) origin: string;
}

@Controller('published-auth/:cruxId')
export class PublishedAuthController {
  constructor(private readonly auth: PublishedAuthService) {}

  @Post('code')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  code(
    @Param('cruxId', ParseUUIDPipe) id: string,
    @Headers('origin') origin: string,
    @Body() body: AuthCodeDto,
  ) {
    return this.auth.code(id, origin, body.email);
  }
  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  login(
    @Param('cruxId', ParseUUIDPipe) id: string,
    @Headers('origin') origin: string,
    @Body() body: AuthLoginDto,
  ) {
    return this.auth.login(id, origin, body.email, body.code);
  }
  @Post('token')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  token(
    @Param('cruxId', ParseUUIDPipe) id: string,
    @Headers('origin') origin: string,
    @Body() body: AuthTokenDto,
  ) {
    return this.auth.refresh(body.refreshToken, id, origin);
  }
  @Post('session')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @UseGuards(AccountOriginGuard, AuthGuard)
  inherit(
    @Param('cruxId', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
    @Body() body: InheritDto,
  ) {
    return this.auth.inherit(id, body.origin, req.headers.origin, req.account);
  }
  @Get('profile')
  @Header('Cache-Control', 'no-store')
  async profile(
    @Param('cruxId', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return (
      await this.auth.visitor(
        req.headers.authorization?.replace(/^Bearer /, ''),
        id,
        req.headers.origin,
      )
    ).visitor;
  }
  @Delete('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  logout(@Param('cruxId', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.auth.logout(
      req.headers.authorization?.replace(/^Bearer /, ''),
      id,
      req.headers.origin,
    );
  }
}
