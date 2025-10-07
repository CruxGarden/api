import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AuthCodeDto } from './dto/auth-code.dto';
import { AuthLoginDto } from './dto/auth-login.dto';
import { AuthTokenDto } from './dto/auth-token.dto';

import { AccountService } from '../account/account.service';
import { AuthorService } from '../author/author.service';
import { EmailService } from '../common/services/email.service';
import { RedisService } from '../common/services/redis.service';
import { LoggerService } from '../common/services/logger.service';
import { KeyMaster } from '../common/services/key.master';
import { AuthCredentials } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';
import Account from '../account/entities/account.entity';

const CODE_EXPIRE = 60 * 5; // 5 minutes
const REFRESH_EXPIRE = 60 * 60 * 24 * 14; // 14 days
const GRANT_EXPIRE = 60 * 60 * 24 * 365; // 1 year
const TOKEN_EXPIRE = 60 * 60; // 1 hour
const AUTH_TOKEN_LENGTH = 16;

const lower = (str) => str?.toLowerCase() || '';

@Injectable()
export class AuthService {
  private readonly logger: LoggerService;

  constructor(
    private readonly accountService: AccountService,
    private readonly authorService: AuthorService,
    private readonly emailService: EmailService,
    private readonly redisService: RedisService,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthService');
    this.logger.debug('AuthService initialized');
  }

  codeKey(code: string): string {
    return `crux:auth:code:${code}`;
  }

  grantEmailKey(email: string): string {
    return `crux:auth:grant:email:${email}`;
  }

  grantIdKey(grantId: string): string {
    return `crux:auth:grant:id:${grantId}`;
  }

  refreshTokenKey(refreshToken: string): string {
    return `crux:auth:refresh:${refreshToken}`;
  }

  genAccessToken(account: Account, grantId: string): string {
    const payload = {
      id: account.id,
      email: account.email,
      role: account.role,
      grantId,
      exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRE,
    };
    return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256' });
  }

  async genRefreshToken(grantId: string): Promise<string> {
    const refreshToken = this.keyMaster.generateKey(AUTH_TOKEN_LENGTH);
    await this.redisService.set(
      this.refreshTokenKey(refreshToken),
      grantId,
      REFRESH_EXPIRE,
    );

    return refreshToken;
  }

  async genGrantId(email: string): Promise<string> {
    const grantId = this.keyMaster.generateKey(AUTH_TOKEN_LENGTH);
    await this.redisService.set(
      this.grantEmailKey(email),
      grantId,
      GRANT_EXPIRE,
    );
    await this.redisService.set(this.grantIdKey(grantId), email, GRANT_EXPIRE);

    return grantId;
  }

  async getGrantIdByEmail(email: string): Promise<string | null> {
    return this.redisService.get(this.grantEmailKey(email));
  }

  async getGrantIdByRefreshToken(refreshToken: string): Promise<string | null> {
    return this.redisService.get(this.refreshTokenKey(refreshToken));
  }

  genAuthCredentials(
    accessToken: string,
    refreshToken: string,
  ): AuthCredentials {
    return { accessToken, refreshToken, expiresIn: TOKEN_EXPIRE };
  }

  async getEmailByCode(code: string): Promise<string | null> {
    const result = await this.redisService.get(this.codeKey(code));
    if (result === null || result === undefined) {
      return null;
    }
    return typeof result === 'string' ? result : result.toString('utf8');
  }

  async getEmailByGrantId(grantId: string): Promise<string | null> {
    const result = await this.redisService.get(this.grantIdKey(grantId));
    if (result === null || result === undefined) {
      return null;
    }
    return typeof result === 'string' ? result : result.toString('utf8');
  }

  async remove(key: string): Promise<null> {
    await this.redisService.del(key);
    return null;
  }

  async code(authCodeDto: AuthCodeDto): Promise<string> {
    const uid = this.keyMaster.generateKey(AUTH_TOKEN_LENGTH);
    const email = lower(authCodeDto.email);
    await this.redisService.set(this.codeKey(uid), email, CODE_EXPIRE);
    await this.emailService.send({
      email,
      subject: 'Auth Code',
      body: `Your auth code is ${uid}`,
    });
    return `Auth Code emailed to ${email}`;
  }

  async login(authLoginDto: AuthLoginDto): Promise<AuthCredentials | null> {
    // 1) lookup email by code
    const email = await this.getEmailByCode(authLoginDto.code);
    if (email !== lower(authLoginDto.email)) return null;

    // 2) lookup existing grant by email or create new grant
    const grantId =
      (await this.getGrantIdByEmail(email)) || (await this.genGrantId(email));

    // 3) create refresh token
    const refreshToken = await this.genRefreshToken(grantId);

    // 4) lookup account by email, create account if not found
    let account = null;
    try {
      account = await this.accountService.findByEmail(email);
    } catch (error) {
      this.logger.error('Failed to check existing account', error, {
        email,
      });
    }
    if (!account) {
      const accountId = this.keyMaster.generateId();
      const authorId = this.keyMaster.generateId();

      // account not found, create one
      try {
        account = await this.accountService.create({
          id: accountId,
          key: this.keyMaster.generateKey(),
          email,
          role: AccountRole.AUTHOR,
        });
        this.logger.info('Created Account', { email, accountId });
      } catch (error) {
        this.logger.error('Failed to create account', error, {
          email,
          accountId,
        });
        account = null;
      }

      // also create author
      const name = email.split('@')[0];
      try {
        const author = await this.authorService.create({
          id: authorId,
          key: this.keyMaster.generateKey(),
          accountId: accountId,
          username: name,
          displayName: name,
        });
        this.logger.info('Created Author', author);
      } catch (error) {
        this.logger.error('Failed to create author', error, {
          email,
          accountId,
          authorId,
          username: name,
        });
        throw error;
      }
    }

    // 5) create jwt access token for account
    const accessToken = this.genAccessToken(account, grantId);

    // 5) cleanup
    await this.remove(this.codeKey(authLoginDto.code));

    return this.genAuthCredentials(accessToken, refreshToken);
  }

  async logout(email: string): Promise<{ message: string } | null> {
    const grantId = await this.getGrantIdByEmail(email);
    if (!grantId) return null;

    await this.remove(this.grantEmailKey(email));
    await this.remove(this.grantIdKey(grantId));

    return { message: 'Logged out' };
  }

  async token(authTokenDto: AuthTokenDto): Promise<AuthCredentials | null> {
    // 1) lookup grant id by refresh token
    const grantId = await this.getGrantIdByRefreshToken(
      authTokenDto.refreshToken,
    );
    if (!grantId) return null;

    // 2) lookup email by grant id
    const email = await this.getEmailByGrantId(grantId);
    if (!email) return null;

    // 3) lookup account by email
    let account = null;
    try {
      account = await this.accountService.findByEmail(email);
    } catch (error) {
      this.logger.error('Failed to verify account during refresh', error, {
        email,
      });
      return null;
    }
    if (!account) {
      return null;
    }

    // 4) create access token for account
    const accessToken = this.genAccessToken(account, grantId);

    // 5) create new refresh token
    const refreshToken = await this.genRefreshToken(grantId);

    // 6) remove old refresh token
    await this.remove(this.refreshTokenKey(authTokenDto.refreshToken));

    return this.genAuthCredentials(accessToken, refreshToken);
  }

  async profile(email: string): Promise<Account | null> {
    try {
      const account = await this.accountService.findByEmail(email);
      return account;
    } catch (error) {
      this.logger.error('Failed to verify account during refresh', error, {
        email,
      });
      return null;
    }
  }
}
