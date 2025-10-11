import { Test, TestingModule } from '@nestjs/testing';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('AccountController', () => {
  let controller: AccountController;
  let service: jest.Mocked<AccountService>;

  const mockAccount = {
    id: 'account-id',
    email: 'test@example.com',
    role: AccountRole.AUTHOR,
    homeId: 'home-id-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockRequest: AuthRequest = {
    account: {
      id: 'account-id',
      email: 'test@example.com',
      role: AccountRole.AUTHOR,
    },
  } as any;

  beforeEach(async () => {
    const mockService = {
      get: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
      controllers: [AccountController],
      providers: [
        { provide: AccountService, useValue: mockService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<AccountController>(AccountController);
    service = module.get(AccountService);
  });

  describe('get', () => {
    it('should return the authenticated account', async () => {
      service.get.mockResolvedValue(mockAccount);

      const result = await controller.get(mockRequest);

      expect(result).toEqual(mockAccount);
      expect(service.get).toHaveBeenCalledWith('account-id');
    });
  });

  describe('update', () => {
    const updateDto = { email: 'updated@example.com' };

    it('should update the authenticated account', async () => {
      const updatedAccount = { ...mockAccount, email: 'updated@example.com' };
      service.update.mockResolvedValue(updatedAccount);

      const result = await controller.update(updateDto, mockRequest);

      expect(result).toEqual(updatedAccount);
      expect(service.update).toHaveBeenCalledWith('account-id', updateDto);
    });
  });

  describe('delete', () => {
    const deleteDto = { confirmationText: 'DELETE MY ACCOUNT' };

    it('should delete the authenticated account', async () => {
      service.delete.mockResolvedValue(null);

      const result = await controller.delete(deleteDto, mockRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('account-id', deleteDto);
    });
  });
});
