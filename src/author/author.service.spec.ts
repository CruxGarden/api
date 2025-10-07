import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { AuthorService } from './author.service';
import { AuthorRepository } from './author.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';

describe('AuthorService', () => {
  let service: AuthorService;
  let repository: jest.Mocked<AuthorRepository>;

  const mockAuthorRaw = {
    id: 'author-id-123',
    key: 'author-key-abc',
    account_id: 'account-123',
    username: 'testuser',
    display_name: 'Test User',
    bio: 'A test bio',
    home_id: 'crux-home-123',
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findAllQuery: jest.fn(),
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
        AuthorService,
        { provide: AuthorRepository, useValue: mockRepository },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<AuthorService>(AuthorService);
    repository = module.get(AuthorRepository);
  });

  describe('findById', () => {
    it('should return an author when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });

      const result = await service.findById('author-id-123');

      expect(result.id).toBe('author-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'author-id-123');
    });

    it('should throw NotFoundException when author not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException on repository error', async () => {
      repository.findBy.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findById('author-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return an author when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });

      const result = await service.findByKey('author-key-abc');

      expect(result.key).toBe('author-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith('key', 'author-key-abc');
    });

    it('should throw NotFoundException when author not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByUsername', () => {
    it('should return an author when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });

      const result = await service.findByUsername('testuser');

      expect(result.username).toBe('testuser');
      expect(repository.findBy).toHaveBeenCalledWith('username', 'testuser');
    });

    it('should throw NotFoundException when author not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByUsername('invalid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByAccountId', () => {
    it('should return an author when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });

      const result = await service.findByAccountId('account-123');

      expect(result.accountId).toBe('account-123');
      expect(repository.findBy).toHaveBeenCalledWith(
        'account_id',
        'account-123',
      );
    });

    it('should throw NotFoundException when author not found for account', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByAccountId('invalid-account')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const createDto = {
      username: 'newuser',
      displayName: 'New User',
      accountId: 'account-456',
    };

    it('should create an author successfully', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });
      repository.create.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('author-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
        key: 'generated-key',
      });
    });

    it('should throw ConflictException when username already exists', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });

      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ConflictException when account already has author', async () => {
      repository.findBy
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: mockAuthorRaw, error: null });

      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });
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
    const updateDto = { displayName: 'Updated Name', bio: 'Updated bio' };

    it('should update an author successfully', async () => {
      const updatedAuthor = { ...mockAuthorRaw, display_name: 'Updated Name' };
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedAuthor,
        error: null,
      });

      const result = await service.update('author-key-abc', updateDto);

      expect(result.displayName).toBe('Updated Name');
      expect(repository.update).toHaveBeenCalledWith(
        mockAuthorRaw.id,
        updateDto,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('author-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete an author successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('author-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockAuthorRaw.id);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockAuthorRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('author-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('asAuthor', () => {
    it('should transform raw author to entity', () => {
      const result = service.asAuthor(mockAuthorRaw);

      expect(result.id).toBe(mockAuthorRaw.id);
      expect(result.accountId).toBe(mockAuthorRaw.account_id);
      expect(result.displayName).toBe(mockAuthorRaw.display_name);
    });
  });

  describe('asAuthors', () => {
    it('should transform array of raw authors to entities', () => {
      const result = service.asAuthors([mockAuthorRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockAuthorRaw.id);
    });
  });
});
