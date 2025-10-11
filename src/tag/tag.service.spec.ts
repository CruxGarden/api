import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { TagService } from './tag.service';
import { TagRepository } from './tag.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { HomeService } from '../home/home.service';
import { ResourceType } from '../common/types/enums';

describe('TagService', () => {
  let service: TagService;
  let repository: jest.Mocked<TagRepository>;

  const mockTagRaw = {
    id: 'tag-id-123',
    key: 'tag-key-abc',
    resource_type: ResourceType.CRUX,
    resource_id: 'crux-123',
    label: 'test-tag',
    author_id: 'author-123',
    home_id: 'home-id-123',
    system: false,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findAllQuery: jest.fn(),
      findByResource: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      createMany: jest.fn(),
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

    const mockHomeService = {
      primary: jest.fn().mockResolvedValue({
        id: 'home-id-123',
        key: 'home-key',
        name: 'Test Home',
        primary: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagService,
        { provide: TagRepository, useValue: mockRepository },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: HomeService, useValue: mockHomeService },
      ],
    }).compile();

    service = module.get<TagService>(TagService);
    repository = module.get(TagRepository);
  });

  describe('findAllQuery', () => {
    it('should delegate to repository findAllQuery', () => {
      const mockQuery = {} as any;
      repository.findAllQuery.mockReturnValue(mockQuery);

      const result = service.findAllQuery(
        ResourceType.CRUX,
        'search',
        'alpha',
        'label',
      );

      expect(result).toBe(mockQuery);
      expect(repository.findAllQuery).toHaveBeenCalledWith(
        ResourceType.CRUX,
        'search',
        'alpha',
        'label',
      );
    });
  });

  describe('findById', () => {
    it('should return a tag when found', async () => {
      repository.findBy.mockResolvedValue({ data: mockTagRaw, error: null });

      const result = await service.findById('tag-id-123');

      expect(result.id).toBe('tag-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'tag-id-123');
    });

    it('should throw NotFoundException when tag not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return a tag when found', async () => {
      repository.findBy.mockResolvedValue({ data: mockTagRaw, error: null });

      const result = await service.findByKey('tag-key-abc');

      expect(result.key).toBe('tag-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith('key', 'tag-key-abc');
    });

    it('should throw NotFoundException when tag not found', async () => {
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

      await expect(service.findByKey('tag-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const updateDto = { label: 'updated-tag' };

    it('should update a tag successfully', async () => {
      const updatedTag = { ...mockTagRaw, label: 'updated-tag' };
      repository.findBy.mockResolvedValue({ data: mockTagRaw, error: null });
      repository.update.mockResolvedValue({ data: updatedTag, error: null });

      const result = await service.update('tag-key-abc', updateDto);

      expect(result.label).toBe('updated-tag');
      expect(repository.update).toHaveBeenCalledWith(mockTagRaw.id, updateDto);
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({ data: mockTagRaw, error: null });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('tag-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a tag successfully', async () => {
      repository.findBy.mockResolvedValue({ data: mockTagRaw, error: null });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('tag-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockTagRaw.id);
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({ data: mockTagRaw, error: null });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('tag-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getTags', () => {
    it('should return tags for a resource', async () => {
      repository.findByResource.mockResolvedValue({
        data: [mockTagRaw],
        error: null,
      });

      const result = await service.getTags(ResourceType.CRUX, 'crux-123');

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('test-tag');
      expect(repository.findByResource).toHaveBeenCalledWith(
        ResourceType.CRUX,
        'crux-123',
      );
    });

    it('should filter tags by label', async () => {
      const tags = [
        { ...mockTagRaw, label: 'javascript' },
        { ...mockTagRaw, label: 'typescript' },
      ];
      repository.findByResource.mockResolvedValue({ data: tags, error: null });

      const result = await service.getTags(
        ResourceType.CRUX,
        'crux-123',
        'script',
      );

      expect(result).toHaveLength(2);
    });

    it('should throw InternalServerErrorException on error', async () => {
      repository.findByResource.mockResolvedValue({
        data: null,
        error: new Error('Fetch error'),
      });

      await expect(
        service.getTags(ResourceType.CRUX, 'crux-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('syncTags', () => {
    it('should add new tags', async () => {
      repository.findByResource.mockResolvedValue({ data: [], error: null });
      repository.createMany.mockResolvedValue({ data: [], error: null });
      repository.findByResource.mockResolvedValueOnce({
        data: [],
        error: null,
      });
      repository.findByResource.mockResolvedValueOnce({
        data: [mockTagRaw],
        error: null,
      });

      await service.syncTags(
        ResourceType.CRUX,
        'crux-123',
        ['test-tag'],
        'author-123',
      );

      expect(repository.createMany).toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('should remove old tags', async () => {
      repository.findByResource
        .mockResolvedValueOnce({ data: [mockTagRaw], error: null })
        .mockResolvedValueOnce({ data: [], error: null });
      repository.delete.mockResolvedValue({ data: null, error: null });

      await service.syncTags(ResourceType.CRUX, 'crux-123', [], 'author-123');

      expect(repository.delete).toHaveBeenCalledWith(mockTagRaw.id);
    });

    it('should normalize labels to lowercase', async () => {
      repository.findByResource.mockResolvedValue({ data: [], error: null });
      repository.createMany.mockResolvedValue({ data: [], error: null });

      await service.syncTags(
        ResourceType.CRUX,
        'crux-123',
        ['JavaScript', 'TypeScript'],
        'author-123',
      );

      const createCall = repository.createMany.mock.calls[0][0];
      expect(createCall[0].label).toBe('javascript');
      expect(createCall[1].label).toBe('typescript');
    });

    it('should throw on create error', async () => {
      repository.findByResource.mockResolvedValue({ data: [], error: null });
      repository.createMany.mockResolvedValue({
        data: null,
        error: new Error('Create failed'),
      });

      await expect(
        service.syncTags(ResourceType.CRUX, 'crux-123', ['tag'], 'author-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw on initial fetch error', async () => {
      repository.findByResource.mockResolvedValue({
        data: null,
        error: new Error('Fetch failed'),
      });

      await expect(
        service.syncTags(ResourceType.CRUX, 'crux-123', ['tag'], 'author-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw on delete error', async () => {
      repository.findByResource
        .mockResolvedValueOnce({ data: [mockTagRaw], error: null })
        .mockResolvedValueOnce({ data: [], error: null });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(
        service.syncTags(ResourceType.CRUX, 'crux-123', [], 'author-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw on final fetch error', async () => {
      repository.findByResource
        .mockResolvedValueOnce({ data: [], error: null })
        .mockResolvedValueOnce({
          data: null,
          error: new Error('Final fetch failed'),
        });

      await expect(
        service.syncTags(ResourceType.CRUX, 'crux-123', [], 'author-123'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
