import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { AccountRepository } from './account.repository';
import { AuthorRepository } from '../author/author.repository';
import { CruxRepository } from '../crux/crux.repository';
import { ThemeRepository } from '../theme/theme.repository';
import { RedisService } from '../common/services/redis.service';
import { DbService } from '../common/services/db.service';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { AccountRole } from '../common/types/enums';

describe('AccountService', () => {
  let service: AccountService;
  let repository: jest.Mocked<AccountRepository>;
  let authorRepository: jest.Mocked<AuthorRepository>;
  let cruxRepository: jest.Mocked<CruxRepository>;
  let themeRepository: jest.Mocked<ThemeRepository>;
  let redisService: jest.Mocked<RedisService>;
  let dbService: jest.Mocked<DbService>;

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

    const mockAuthorRepository = {
      findBy: jest.fn(),
      deleteByAccountId: jest.fn(),
    };

    const mockCruxRepository = {
      findAllByAuthorId: jest.fn(),
      delete: jest.fn(),
    };

    const mockThemeRepository = {
      deleteByAuthorId: jest.fn(),
    };

    const mockRedisService = {
      get: jest.fn(),
      del: jest.fn(),
    };

    const mockDbService = {
      query: jest.fn().mockReturnValue({
        transaction: jest.fn().mockResolvedValue({
          commit: jest.fn().mockResolvedValue(undefined),
          rollback: jest.fn().mockResolvedValue(undefined),
        }),
      }),
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
        { provide: AuthorRepository, useValue: mockAuthorRepository },
        { provide: CruxRepository, useValue: mockCruxRepository },
        { provide: ThemeRepository, useValue: mockThemeRepository },
        { provide: RedisService, useValue: mockRedisService },
        { provide: DbService, useValue: mockDbService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<AccountService>(AccountService);
    repository = module.get(AccountRepository);
    authorRepository = module.get(AuthorRepository);
    cruxRepository = module.get(CruxRepository);
    themeRepository = module.get(ThemeRepository);
    redisService = module.get(RedisService);
    dbService = module.get(DbService);
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

    it('should invalidate tokens when email is changed', async () => {
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
      redisService.get.mockResolvedValue('grant-id-123');

      await service.update('account-id-123', updateDto);

      expect(redisService.get).toHaveBeenCalledWith(
        'crux:auth:grant:email:test@example.com',
      );
      expect(redisService.del).toHaveBeenCalledWith(
        'crux:auth:grant:email:test@example.com',
      );
      expect(redisService.del).toHaveBeenCalledWith(
        'crux:auth:grant:id:grant-id-123',
      );
    });

    it('should not invalidate tokens when email is unchanged', async () => {
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

      expect(redisService.get).not.toHaveBeenCalled();
      expect(redisService.del).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    const deleteDto = { confirmationText: 'DELETE MY ACCOUNT' };

    let mockTrx: any;

    beforeEach(() => {
      mockTrx = {
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      };

      (dbService.query as jest.Mock).mockReturnValue({
        transaction: jest.fn().mockResolvedValue(mockTrx),
      });
    });

    it('should delete an account successfully with no author', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      authorRepository.findBy.mockResolvedValue({ data: null, error: null });
      authorRepository.deleteByAccountId.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('account-id-123', deleteDto);

      expect(result).toBeNull();
      expect(authorRepository.deleteByAccountId).toHaveBeenCalledWith(
        'account-id-123',
        mockTrx,
      );
      expect(repository.delete).toHaveBeenCalledWith('account-id-123', mockTrx);
      expect(mockTrx.commit).toHaveBeenCalled();
    });

    it('should delete an account with author and cascade delete content', async () => {
      const mockAuthor = {
        id: 'author-id-123',
        key: 'author-key-abc',
        account_id: 'account-id-123',
        username: 'testuser',
        display_name: 'Test User',
        bio: null,
        root_id: null,
        home_id: 'home-id-123',
        type: null,
        kind: null,
        meta: null,
        created: new Date(),
        updated: new Date(),
        deleted: null,
      };

      const mockCruxes = [
        {
          id: 'crux-1',
          key: 'crux-key-1',
          slug: 'crux-1',
          title: null,
          description: null,
          data: 'content',
          type: null,
          status: null,
          visibility: null,
          author_id: 'author-id-123',
          account_id: 'account-id-123',
          home_id: 'home-id-123',
          theme_id: null,
          meta: null,
          created: new Date(),
          updated: new Date(),
          deleted: null,
        },
        {
          id: 'crux-2',
          key: 'crux-key-2',
          slug: 'crux-2',
          title: null,
          description: null,
          data: 'content',
          type: null,
          status: null,
          visibility: null,
          author_id: 'author-id-123',
          account_id: 'account-id-123',
          home_id: 'home-id-123',
          theme_id: null,
          meta: null,
          created: new Date(),
          updated: new Date(),
          deleted: null,
        },
      ];

      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      authorRepository.findBy.mockResolvedValue({
        data: mockAuthor,
        error: null,
      });
      cruxRepository.findAllByAuthorId.mockResolvedValue({
        data: mockCruxes,
        error: null,
      });
      cruxRepository.delete.mockResolvedValue({ data: null, error: null });
      themeRepository.deleteByAuthorId.mockResolvedValue({
        data: null,
        error: null,
      });
      authorRepository.deleteByAccountId.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('account-id-123', deleteDto);

      expect(result).toBeNull();
      expect(cruxRepository.findAllByAuthorId).toHaveBeenCalledWith(
        'author-id-123',
      );
      expect(cruxRepository.delete).toHaveBeenCalledTimes(2);
      expect(cruxRepository.delete).toHaveBeenCalledWith('crux-1', mockTrx);
      expect(cruxRepository.delete).toHaveBeenCalledWith('crux-2', mockTrx);
      expect(themeRepository.deleteByAuthorId).toHaveBeenCalledWith(
        'author-id-123',
        mockTrx,
      );
      expect(authorRepository.deleteByAccountId).toHaveBeenCalledWith(
        'account-id-123',
        mockTrx,
      );
      expect(repository.delete).toHaveBeenCalledWith('account-id-123', mockTrx);
      expect(mockTrx.commit).toHaveBeenCalled();
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

    it('should rollback transaction on delete error', async () => {
      repository.findById.mockResolvedValue({
        data: mockAccountRaw,
        error: null,
      });
      authorRepository.findBy.mockResolvedValue({ data: null, error: null });
      authorRepository.deleteByAccountId.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('account-id-123', deleteDto)).rejects.toThrow(
        InternalServerErrorException,
      );

      expect(mockTrx.rollback).toHaveBeenCalled();
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
