import {
  Controller,
  Get,
  Post,
  Body,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
  UnauthorizedException,
  NotFoundException,
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
  private readonly logger: LoggerService;

  constructor(
    private readonly authService: AuthService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthController');
    this.logger.debug('AuthController initialized');
  }

  @Post('code')
  @AuthSwagger.RequestCode()
  async code(@Body() codeDto: AuthCodeDto): Promise<{ message: string }> {
    const message = await this.authService.code(codeDto);
    return { message };
  }

  @Post('login')
  @AuthSwagger.Login()
  async login(@Body() loginDto: AuthLoginDto): Promise<AuthCredentials | null> {
    const creds = await this.authService.login(loginDto);
    if (!creds) throw new UnauthorizedException();

    return creds;
  }

  @Post('token')
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

  @Post('logout')
  @UseGuards(AuthGuard)
  @AuthSwagger.Logout()
  async logout(@Request() req: AuthRequest): Promise<{ message: string }> {
    return this.authService.logout(req.account.email);
  }
}
