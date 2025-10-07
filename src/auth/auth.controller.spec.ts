import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('AuthController', () => {
  let controller: AuthController;
  let service: jest.Mocked<AuthService>;

  const mockAccount = {
    id: 'account-123',
    key: 'account-key',
    email: 'test@example.com',
    role: AccountRole.AUTHOR,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  const mockAuthCredentials = {
    accessToken: 'access-token-123',
    refreshToken: 'refresh-token-123',
    expiresIn: 3600,
  };

  const mockRequest: AuthRequest = {
    account: {
      id: 'account-123',
      email: 'test@example.com',
      role: AccountRole.AUTHOR,
    },
  } as any;

  beforeEach(async () => {
    const mockService = {
      code: jest.fn(),
      login: jest.fn(),
      token: jest.fn(),
      profile: jest.fn(),
      logout: jest.fn(),
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
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    })
      .overrideGuard(require('../common/guards/auth.guard').AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<AuthController>(AuthController);
    service = module.get(AuthService);
  });

  describe('code', () => {
    it('should request auth code successfully', async () => {
      const codeDto = { email: 'test@example.com' };
      service.code.mockResolvedValue('Auth Code emailed to test@example.com');

      const result = await controller.code(codeDto);

      expect(result).toEqual({
        message: 'Auth Code emailed to test@example.com',
      });
      expect(service.code).toHaveBeenCalledWith(codeDto);
    });
  });

  describe('login', () => {
    it('should login successfully', async () => {
      const loginDto = { email: 'test@example.com', code: 'code-123' };
      service.login.mockResolvedValue(mockAuthCredentials);

      const result = await controller.login(loginDto);

      expect(result).toEqual(mockAuthCredentials);
      expect(service.login).toHaveBeenCalledWith(loginDto);
    });

    it('should throw UnauthorizedException when login fails', async () => {
      const loginDto = { email: 'test@example.com', code: 'invalid-code' };
      service.login.mockResolvedValue(null);

      await expect(controller.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('token', () => {
    it('should refresh token successfully', async () => {
      const tokenDto = { refreshToken: 'refresh-token-123' };
      service.token.mockResolvedValue(mockAuthCredentials);

      const result = await controller.token(tokenDto);

      expect(result).toEqual(mockAuthCredentials);
      expect(service.token).toHaveBeenCalledWith(tokenDto);
    });

    it('should throw UnauthorizedException when token refresh fails', async () => {
      const tokenDto = { refreshToken: 'invalid-refresh-token' };
      service.token.mockResolvedValue(null);

      await expect(controller.token(tokenDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('profile', () => {
    it('should return user profile', async () => {
      service.profile.mockResolvedValue(mockAccount as any);

      const result = await controller.profile(mockRequest);

      expect(result).toEqual(mockAccount);
      expect(service.profile).toHaveBeenCalledWith('test@example.com');
    });

    it('should throw NotFoundException when profile not found', async () => {
      service.profile.mockResolvedValue(null);

      await expect(controller.profile(mockRequest)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      service.logout.mockResolvedValue({ message: 'Logged out' });

      const result = await controller.logout(mockRequest);

      expect(result).toEqual({ message: 'Logged out' });
      expect(service.logout).toHaveBeenCalledWith('test@example.com');
    });
  });
});
