import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HomeService } from './home.service';
import { HomeRepository } from './home.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';

describe('HomeService', () => {
  let service: HomeService;
  let repository: jest.Mocked<HomeRepository>;

  const mockHomeRaw = {
    id: 'home-id-123',
    key: 'home-key-abc',
    name: 'Test Home',
    description: 'A test home',
    primary: true,
    type: 'personal',
    kind: 'garden',
    meta: { color: 'blue', icon: 'tree' },
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
        HomeService,
        { provide: HomeRepository, useValue: mockRepository },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<HomeService>(HomeService);
    repository = module.get(HomeRepository);
  });

  describe('findById', () => {
    it('should return a home when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });

      const result = await service.findById('home-id-123');

      expect(result.id).toBe('home-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'home-id-123');
    });

    it('should throw NotFoundException when home not found', async () => {
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

      await expect(service.findById('home-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return a home when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });

      const result = await service.findByKey('home-key-abc');

      expect(result.key).toBe('home-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith('key', 'home-key-abc');
    });

    it('should throw NotFoundException when home not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findByKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException on repository error', async () => {
      repository.findBy.mockResolvedValue({
        data: null,
        error: new Error('DB Error'),
      });

      await expect(service.findByKey('home-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const createDto = {
      name: 'Test Home',
      description: 'A test home',
      primary: true,
      type: 'personal',
      kind: 'garden',
    };

    it('should create a home successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('home-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
        key: 'generated-key',
      });
    });

    it('should throw InternalServerErrorException on create error', async () => {
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
    const updateDto = { name: 'Updated Home', description: 'Updated' };

    it('should update a home successfully', async () => {
      const updatedHome = { ...mockHomeRaw, name: 'Updated Home' };
      repository.findBy.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedHome,
        error: null,
      });

      const result = await service.update('home-key-abc', updateDto);

      expect(result.name).toBe('Updated Home');
      expect(repository.update).toHaveBeenCalledWith(mockHomeRaw.id, updateDto);
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('home-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a home successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('home-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockHomeRaw.id);
    });

    it('should throw NotFoundException when home not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.delete('home-key')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockHomeRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('home-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('asHome', () => {
    it('should transform raw home to entity', () => {
      const result = service.asHome(mockHomeRaw);

      expect(result.id).toBe(mockHomeRaw.id);
      expect(result.name).toBe(mockHomeRaw.name);
      expect(result.primary).toBe(mockHomeRaw.primary);
    });
  });

  describe('asHomes', () => {
    it('should transform array of raw homes to entities', () => {
      const result = service.asHomes([mockHomeRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockHomeRaw.id);
    });
  });
});
