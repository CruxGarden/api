import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
  UnauthorizedException,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthCodeDto } from './dto/auth-code.dto';
import { AuthLoginDto } from './dto/auth-login.dto';
import { AuthTokenDto } from './dto/auth-token.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AuthSwagger } from './auth.swagger';
import { LoggerService } from '../common/services/logger.service';
import Account from '../account/entities/account.entity';
import { AuthCredentials } from '../common/types/interfaces';

@Controller('auth')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
@AuthSwagger.Controller()
export class AuthController {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly authService: AuthService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthController');
  }

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.RequestCode()
  async code(@Body() codeDto: AuthCodeDto): Promise<{ message: string }> {
    const message = await this.authService.code(codeDto);
    return { message };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.Login()
  async login(@Body() loginDto: AuthLoginDto): Promise<AuthCredentials | null> {
    const creds = await this.authService.login(loginDto);
    if (!creds) throw new UnauthorizedException();

    return creds;
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.Token()
  async token(@Body() tokenDto: AuthTokenDto): Promise<AuthCredentials | null> {
    const creds = await this.authService.token(tokenDto);
    if (!creds) throw new UnauthorizedException();

    return creds;
  }

  @Get('profile')
  @UseGuards(AuthGuard)
  @AuthSwagger.Profile()
  async profile(@Request() req: AuthRequest): Promise<Account | null> {
    let accountProfile = await this.authService.profile(req.account.email);
    if (!accountProfile) throw new NotFoundException();

    return accountProfile;
  }

  @Delete('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  @AuthSwagger.Logout()
  async logout(@Request() req: AuthRequest): Promise<null> {
    await this.authService.logout(req.account.email);
    return null;
  }
}
