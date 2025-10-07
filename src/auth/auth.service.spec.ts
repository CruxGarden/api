import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { AccountService } from '../account/account.service';
import { AuthorService } from '../author/author.service';
import { EmailService } from '../common/services/email.service';
import { RedisService } from '../common/services/redis.service';
import { LoggerService } from '../common/services/logger.service';
import { KeyMaster } from '../common/services/key.master';
import { AccountRole } from '../common/types/enums';

// Mock jwt module
jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: {
    sign: jest.fn(() => 'mocked-jwt-token'),
  },
}));

describe('AuthService', () => {
  let service: AuthService;
  let accountService: jest.Mocked<AccountService>;
  let authorService: jest.Mocked<AuthorService>;
  let emailService: jest.Mocked<EmailService>;
  let redisService: jest.Mocked<RedisService>;

  const mockAccount = {
    id: 'account-123',
    key: 'account-key',
    email: 'test@example.com',
    role: AccountRole.AUTHOR,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockAuthor = {
    id: 'author-123',
    key: 'author-key',
    accountId: 'account-123',
    username: 'test',
    displayName: 'test',
  };

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';

    const mockAccountService = {
      findByEmail: jest.fn(),
      create: jest.fn(),
    };

    const mockAuthorService = {
      create: jest.fn(),
    };

    const mockEmailService = {
      send: jest.fn(),
    };

    const mockRedisService = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const mockKeyMaster = {
      generateId: jest.fn().mockReturnValue('generated-id'),
      generateKey: jest.fn().mockReturnValue('generated-key'),
    };

    const mockLoggerService = {
      createChildLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AccountService, useValue: mockAccountService },
        { provide: AuthorService, useValue: mockAuthorService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    accountService = module.get(AccountService);
    authorService = module.get(AuthorService);
    emailService = module.get(EmailService);
    redisService = module.get(RedisService);
  });

  describe('key generation helpers', () => {
    it('should generate code key', () => {
      expect(service.codeKey('test-code')).toBe('crux:auth:code:test-code');
    });

    it('should generate grant email key', () => {
      expect(service.grantEmailKey('test@example.com')).toBe(
        'crux:auth:grant:email:test@example.com',
      );
    });

    it('should generate grant id key', () => {
      expect(service.grantIdKey('grant-123')).toBe(
        'crux:auth:grant:id:grant-123',
      );
    });

    it('should generate refresh token key', () => {
      expect(service.refreshTokenKey('refresh-abc')).toBe(
        'crux:auth:refresh:refresh-abc',
      );
    });
  });

  describe('genAccessToken', () => {
    it('should generate JWT access token', () => {
      const token = service.genAccessToken(mockAccount as any, 'grant-123');

      expect(token).toBe('mocked-jwt-token');
    });
  });

  describe('genRefreshToken', () => {
    it('should generate and store refresh token', async () => {
      redisService.set.mockResolvedValue('OK');

      const token = await service.genRefreshToken('grant-123');

      expect(token).toBe('generated-key');
      expect(redisService.set).toHaveBeenCalledWith(
        'crux:auth:refresh:generated-key',
        'grant-123',
        expect.any(Number),
      );
    });
  });

  describe('genGrantId', () => {
    it('should generate and store grant id', async () => {
      redisService.set.mockResolvedValue('OK');

      const grantId = await service.genGrantId('test@example.com');

      expect(grantId).toBe('generated-key');
      expect(redisService.set).toHaveBeenCalledTimes(2);
      expect(redisService.set).toHaveBeenCalledWith(
        'crux:auth:grant:email:test@example.com',
        'generated-key',
        expect.any(Number),
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'crux:auth:grant:id:generated-key',
        'test@example.com',
        expect.any(Number),
      );
    });
  });

  describe('getGrantIdByEmail', () => {
    it('should retrieve grant id by email', async () => {
      redisService.get.mockResolvedValue('grant-123');

      const result = await service.getGrantIdByEmail('test@example.com');

      expect(result).toBe('grant-123');
      expect(redisService.get).toHaveBeenCalledWith(
        'crux:auth:grant:email:test@example.com',
      );
    });
  });

  describe('getGrantIdByRefreshToken', () => {
    it('should retrieve grant id by refresh token', async () => {
      redisService.get.mockResolvedValue('grant-123');

      const result = await service.getGrantIdByRefreshToken('refresh-abc');

      expect(result).toBe('grant-123');
      expect(redisService.get).toHaveBeenCalledWith(
        'crux:auth:refresh:refresh-abc',
      );
    });
  });

  describe('genAuthCredentials', () => {
    it('should generate auth credentials object', () => {
      const creds = service.genAuthCredentials('access-token', 'refresh-token');

      expect(creds).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
      });
    });
  });

  describe('getEmailByCode', () => {
    it('should retrieve email by code', async () => {
      redisService.get.mockResolvedValue('test@example.com');

      const result = await service.getEmailByCode('code-123');

      expect(result).toBe('test@example.com');
      expect(redisService.get).toHaveBeenCalledWith('crux:auth:code:code-123');
    });

    it('should return null when code not found', async () => {
      redisService.get.mockResolvedValue(null);

      const result = await service.getEmailByCode('invalid-code');

      expect(result).toBeNull();
    });

    it('should convert buffer to string', async () => {
      redisService.get.mockResolvedValue(Buffer.from('test@example.com'));

      const result = await service.getEmailByCode('code-123');

      expect(result).toBe('test@example.com');
    });
  });

  describe('getEmailByGrantId', () => {
    it('should retrieve email by grant id', async () => {
      redisService.get.mockResolvedValue('test@example.com');

      const result = await service.getEmailByGrantId('grant-123');

      expect(result).toBe('test@example.com');
      expect(redisService.get).toHaveBeenCalledWith(
        'crux:auth:grant:id:grant-123',
      );
    });

    it('should return null when grant not found', async () => {
      redisService.get.mockResolvedValue(null);

      const result = await service.getEmailByGrantId('invalid-grant');

      expect(result).toBeNull();
    });

    it('should convert buffer to string', async () => {
      redisService.get.mockResolvedValue(Buffer.from('test@example.com'));

      const result = await service.getEmailByGrantId('grant-123');

      expect(result).toBe('test@example.com');
    });
  });

  describe('remove', () => {
    it('should delete key from redis', async () => {
      redisService.del.mockResolvedValue(1);

      const result = await service.remove('test-key');

      expect(result).toBeNull();
      expect(redisService.del).toHaveBeenCalledWith('test-key');
    });
  });

  describe('code', () => {
    it('should generate and email auth code', async () => {
      redisService.set.mockResolvedValue('OK');
      emailService.send.mockResolvedValue(undefined);

      const result = await service.code({ email: 'Test@Example.com' });

      expect(result).toBe('Auth Code emailed to test@example.com');
      expect(redisService.set).toHaveBeenCalledWith(
        'crux:auth:code:generated-key',
        'test@example.com',
        300,
      );
      expect(emailService.send).toHaveBeenCalledWith({
        email: 'test@example.com',
        subject: 'Auth Code',
        body: 'Your auth code is generated-key',
      });
    });
  });

  describe('login', () => {
    it('should login existing user successfully', async () => {
      redisService.get.mockResolvedValueOnce('test@example.com'); // getEmailByCode
      redisService.get.mockResolvedValueOnce('grant-123'); // getGrantIdByEmail
      redisService.set.mockResolvedValue('OK');
      redisService.del.mockResolvedValue(1);
      accountService.findByEmail.mockResolvedValue(mockAccount as any);

      const result = await service.login({
        email: 'test@example.com',
        code: 'code-123',
      });

      expect(result).toBeTruthy();
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBe('generated-key');
      expect(result.expiresIn).toBe(3600);
      expect(accountService.findByEmail).toHaveBeenCalledWith(
        'test@example.com',
      );
      expect(redisService.del).toHaveBeenCalledWith('crux:auth:code:code-123');
    });

    it('should return null when code does not match email', async () => {
      redisService.get.mockResolvedValue('other@example.com');

      const result = await service.login({
        email: 'test@example.com',
        code: 'code-123',
      });

      expect(result).toBeNull();
    });

    it('should create new account and author for new user', async () => {
      redisService.get.mockResolvedValueOnce('test@example.com'); // getEmailByCode
      redisService.get.mockResolvedValueOnce(null); // getGrantIdByEmail (no existing grant)
      redisService.set.mockResolvedValue('OK');
      redisService.del.mockResolvedValue(1);
      accountService.findByEmail.mockResolvedValue(null);
      accountService.create.mockResolvedValue(mockAccount as any);
      authorService.create.mockResolvedValue(mockAuthor as any);

      const result = await service.login({
        email: 'test@example.com',
        code: 'code-123',
      });

      expect(result).toBeTruthy();
      expect(accountService.create).toHaveBeenCalledWith({
        id: 'generated-id',
        key: 'generated-key',
        email: 'test@example.com',
        role: AccountRole.AUTHOR,
      });
      expect(authorService.create).toHaveBeenCalledWith({
        id: 'generated-id',
        key: 'generated-key',
        accountId: 'generated-id',
        username: 'test',
        displayName: 'test',
      });
    });

    it('should handle account creation error gracefully', async () => {
      redisService.get.mockResolvedValueOnce('test@example.com');
      redisService.get.mockResolvedValueOnce(null);
      redisService.set.mockResolvedValue('OK');
      accountService.findByEmail.mockResolvedValue(null);
      accountService.create.mockRejectedValue(new Error('DB Error'));

      await expect(
        service.login({
          email: 'test@example.com',
          code: 'code-123',
        }),
      ).rejects.toThrow();
    });

    it('should handle author creation error', async () => {
      redisService.get.mockResolvedValueOnce('test@example.com');
      redisService.get.mockResolvedValueOnce(null);
      redisService.set.mockResolvedValue('OK');
      accountService.findByEmail.mockResolvedValue(null);
      accountService.create.mockResolvedValue(mockAccount as any);
      authorService.create.mockRejectedValue(
        new Error('Author creation failed'),
      );

      await expect(
        service.login({
          email: 'test@example.com',
          code: 'code-123',
        }),
      ).rejects.toThrow('Author creation failed');
    });
  });

  describe('logout', () => {
    it('should logout user successfully', async () => {
      redisService.get.mockResolvedValue('grant-123');
      redisService.del.mockResolvedValue(1);

      const result = await service.logout('test@example.com');

      expect(result).toEqual({ message: 'Logged out' });
      expect(redisService.del).toHaveBeenCalledWith(
        'crux:auth:grant:email:test@example.com',
      );
      expect(redisService.del).toHaveBeenCalledWith(
        'crux:auth:grant:id:grant-123',
      );
    });

    it('should return null when no grant found', async () => {
      redisService.get.mockResolvedValue(null);

      const result = await service.logout('test@example.com');

      expect(result).toBeNull();
    });
  });

  describe('token', () => {
    it('should refresh token successfully', async () => {
      redisService.get.mockResolvedValueOnce('grant-123'); // getGrantIdByRefreshToken
      redisService.get.mockResolvedValueOnce('test@example.com'); // getEmailByGrantId
      redisService.set.mockResolvedValue('OK');
      redisService.del.mockResolvedValue(1);
      accountService.findByEmail.mockResolvedValue(mockAccount as any);

      const result = await service.token({ refreshToken: 'old-refresh-token' });

      expect(result).toBeTruthy();
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBe('generated-key');
      expect(redisService.del).toHaveBeenCalledWith(
        'crux:auth:refresh:old-refresh-token',
      );
    });

    it('should return null when refresh token invalid', async () => {
      redisService.get.mockResolvedValue(null);

      const result = await service.token({ refreshToken: 'invalid-token' });

      expect(result).toBeNull();
    });

    it('should return null when grant id not found', async () => {
      redisService.get.mockResolvedValueOnce('grant-123');
      redisService.get.mockResolvedValueOnce(null); // no email for grant

      const result = await service.token({ refreshToken: 'refresh-token' });

      expect(result).toBeNull();
    });

    it('should return null when account not found', async () => {
      redisService.get.mockResolvedValueOnce('grant-123');
      redisService.get.mockResolvedValueOnce('test@example.com');
      accountService.findByEmail.mockResolvedValue(null);

      const result = await service.token({ refreshToken: 'refresh-token' });

      expect(result).toBeNull();
    });

    it('should handle account lookup error', async () => {
      redisService.get.mockResolvedValueOnce('grant-123');
      redisService.get.mockResolvedValueOnce('test@example.com');
      accountService.findByEmail.mockRejectedValue(new Error('DB Error'));

      const result = await service.token({ refreshToken: 'refresh-token' });

      expect(result).toBeNull();
    });
  });

  describe('profile', () => {
    it('should return account profile', async () => {
      accountService.findByEmail.mockResolvedValue(mockAccount as any);

      const result = await service.profile('test@example.com');

      expect(result).toEqual(mockAccount);
      expect(accountService.findByEmail).toHaveBeenCalledWith(
        'test@example.com',
      );
    });

    it('should return null on error', async () => {
      accountService.findByEmail.mockRejectedValue(new Error('DB Error'));

      const result = await service.profile('test@example.com');

      expect(result).toBeNull();
    });
  });
});
