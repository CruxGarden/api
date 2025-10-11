import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { AccountRepository } from './account.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { AccountRole } from '../common/types/enums';

describe('AccountService', () => {
  let service: AccountService;
  let repository: jest.Mocked<AccountRepository>;

  const mockAccountRaw = {
    id: 'account-id-123',
    key: 'account-key-abc',
    email: 'test@example.com',
    role: 'author' as const,
    home_id: 'home-id-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
        AccountService,
        { provide: AccountRepository, useValue: mockRepository },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<AccountService>(AccountService);
    repository = module.get(AccountRepository);
  });

  describe('findById', () => {
    it('should return an account when found', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      const result = await service.findById('account-id-123');

      expect(result.id).toBe('account-id-123');
      expect(repository.findById).toHaveBeenCalledWith('account-id-123');
    });

    it('should throw NotFoundException when account not found', async () => {
      repository.findById.mockResolvedValue({ data: null, error: null });

      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on repository error', async () => {
      repository.findById.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findById('account-id')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('findByEmail', () => {
    it('should return an account when found', async () => {
      repository.findByEmail.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      const result = await service.findByEmail('test@example.com');

      expect(result.email).toBe('test@example.com');
      expect(repository.findByEmail).toHaveBeenCalledWith('test@example.com');
    });

    it('should format email to lowercase and trim', async () => {
      repository.findByEmail.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      await service.findByEmail('  TEST@EXAMPLE.COM  ');

      expect(repository.findByEmail).toHaveBeenCalledWith('test@example.com');
    });

    it('should return null when account not found', async () => {
      repository.findByEmail.mockResolvedValue({ data: null, error: null });

      const result = await service.findByEmail('notfound@example.com');

      expect(result).toBeNull();
    });

    it('should throw InternalServerErrorException on repository error', async () => {
      repository.findByEmail.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findByEmail('test@example.com')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('get', () => {
    it('should call findById', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      const result = await service.get('account-id-123');

      expect(result.id).toBe('account-id-123');
      expect(repository.findById).toHaveBeenCalledWith('account-id-123');
    });
  });

  describe('create', () => {
    const createDto = {
      email: 'new@example.com',
      role: AccountRole.AUTHOR,
    } as any;

    it('should create an account successfully', async () => {
      repository.findByEmail.mockResolvedValue({ data: null, error: null });
      repository.create.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('account-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        email: 'new@example.com',
        id: 'generated-id',
        key: 'generated-key',
      });
    });

    it('should format email before creation', async () => {
      repository.findByEmail.mockResolvedValue({ data: null, error: null });
      repository.create.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      await service.create({ ...createDto, email: '  NEW@EXAMPLE.COM  ' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com',
        }),
      );
    });

    it('should throw ConflictException when email already exists', async () => {
      repository.findByEmail.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.findByEmail.mockResolvedValue({ data: null, error: null });
      repository.create.mockResolvedValue({
        data: null,
        error: new Error('Create failed'),
      });

      await expect(service.create(createDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('update', () => {
    const updateDto = { email: 'updated@example.com' };

    it('should update an account successfully', async () => {
      const updatedAccount = {
        ...mockAccountRaw,
        email: 'updated@example.com',
      };
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.findByEmail.mockResolvedValue({ data: null, error: null });
      repository.update.mockResolvedValue({
        data: updatedAccount,
        error: null,
      });

      const result = await service.update('account-id-123', updateDto);

      expect(result.email).toBe('updated@example.com');
      expect(repository.update).toHaveBeenCalledWith('account-id-123', {
        email: 'updated@example.com',
      });
    });

    it('should format email before update', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.findByEmail.mockResolvedValue({ data: null, error: null });
      repository.update.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      await service.update('account-id-123', {
        email: '  UPDATED@EXAMPLE.COM  ',
      });

      expect(repository.update).toHaveBeenCalledWith(
        'account-id-123',
        expect.objectContaining({
          email: 'updated@example.com',
        }),
      );
    });

    it('should not check for email conflict when email unchanged', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      await service.update('account-id-123', {
        email: 'test@example.com',
      });

      expect(repository.findByEmail).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when new email already in use', async () => {
      const otherAccount = { ...mockAccountRaw, id: 'other-id' };
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.findByEmail.mockResolvedValue({
        data: otherAccount,
        error: null,
      });

      await expect(service.update('account-id-123', updateDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.findByEmail.mockResolvedValue({ data: null, error: null });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('account-id-123', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    const deleteDto = { confirmationText: 'DELETE MY ACCOUNT' };

    it('should delete an account successfully', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('account-id-123', deleteDto);

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith('account-id-123');
    });

    it('should throw BadRequestException when confirmation text is incorrect', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });

      await expect(
        service.delete('account-id-123', { confirmationText: 'wrong text' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('account-id-123', deleteDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('formatEmail', () => {
    it('should lowercase and trim email', () => {
      const result = service.formatEmail('  TEST@EXAMPLE.COM  ');
      expect(result).toBe('test@example.com');
    });

    it('should handle already formatted email', () => {
      const result = service.formatEmail('test@example.com');
      expect(result).toBe('test@example.com');
    });
  });

  describe('same', () => {
    it('should return true for same emails (case insensitive)', () => {
      const result = service.same('test@example.com', 'TEST@EXAMPLE.COM');
      expect(result).toBe(true);
    });

    it('should return false for different emails', () => {
      const result = service.same('test@example.com', 'other@example.com');
      expect(result).toBe(false);
    });
  });

  describe('asAccount', () => {
    it('should transform raw account to entity', () => {
      const result = service.asAccount(mockAccountRaw);

      expect(result.id).toBe(mockAccountRaw.id);
      expect(result.email).toBe(mockAccountRaw.email);
    });
  });

  describe('asAccounts', () => {
    it('should transform array of raw accounts to entities', () => {
      const result = service.asAccounts([mockAccountRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockAccountRaw.id);
    });
  });
});
