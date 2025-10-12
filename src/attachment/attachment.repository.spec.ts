import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentRepository } from './attachment.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('AttachmentRepository', () => {
  let repository: AttachmentRepository;
  let mockQueryBuilder: any;

  const mockAttachment = {
    id: 'attachment-id',
    key: 'attachment-key',
    type: 'image',
    kind: 'photo',
    meta: { caption: 'Test image' },
    resource_id: 'resource-123',
    resource_type: 'crux',
    author_id: 'author-123',
    home_id: 'home-123',
    encoding: '7bit',
    mime_type: 'image/jpeg',
    filename: 'test.jpg',
    size: 1024,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    // Reset query builder before each test
    mockQueryBuilder = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };

    const mockDbService = {
      query: jest.fn().mockReturnValue(mockQueryBuilder),
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
        AttachmentRepository,
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    repository = module.get<AttachmentRepository>(AttachmentRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findBy', () => {
    it('should return attachment when found', async () => {
      mockQueryBuilder.first.mockResolvedValue(mockAttachment);

      const result = await repository.findBy('key', 'attachment-key');

      expect(result.data).toEqual(mockAttachment);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'key',
        'attachment-key',
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.first.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findBy('key', 'attachment-key');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findByResource', () => {
    it('should return attachments for a resource', async () => {
      mockQueryBuilder.orderBy.mockResolvedValue([mockAttachment]);

      const result = await repository.findByResource('crux', 'resource-123');

      expect(result.data).toEqual([mockAttachment]);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_type',
        'crux',
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'resource_id',
        'resource-123',
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.orderBy.mockRejectedValue(new Error('DB Error'));

      const result = await repository.findByResource('crux', 'resource-123');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('findAllQuery', () => {
    it('should build query for all attachments', () => {
      const result = repository.findAllQuery();

      expect(mockQueryBuilder.whereNull).toHaveBeenCalledWith('deleted');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('created', 'desc');
      expect(result).toBe(mockQueryBuilder);
    });
  });

  describe('create', () => {
    it('should create attachment successfully', async () => {
      const createData = {
        id: 'attachment-id',
        key: 'attachment-key',
        type: 'image',
        kind: 'photo',
        meta: { caption: 'Test' },
        resourceId: 'resource-123',
        resourceType: 'crux',
        authorId: 'author-123',
        homeId: 'home-123',
        encoding: '7bit',
        mimeType: 'image/jpeg',
        filename: 'test.jpg',
        size: 1024,
      };

      mockQueryBuilder.insert.mockResolvedValue(undefined);
      mockQueryBuilder.first.mockResolvedValue(mockAttachment);

      const result = await repository.create(createData);

      expect(result.data).toEqual(mockAttachment);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          created: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.insert.mockRejectedValue(new Error('Insert failed'));

      const result = await repository.create({
        id: 'id',
        key: 'key',
        type: 'image',
        kind: 'photo',
        resourceId: 'resource',
        resourceType: 'crux',
        authorId: 'author',
        homeId: 'home',
        encoding: '7bit',
        mimeType: 'image/jpeg',
        filename: 'test.jpg',
        size: 1024,
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('update', () => {
    it('should update attachment successfully', async () => {
      const updateData = { filename: 'updated.jpg' };
      const updatedAttachment = { ...mockAttachment, filename: 'updated.jpg' };

      mockQueryBuilder.update.mockResolvedValue(1);
      mockQueryBuilder.first.mockResolvedValue(updatedAttachment);

      const result = await repository.update('attachment-id', updateData);

      expect(result.data).toEqual(updatedAttachment);
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Update failed'));

      const result = await repository.update('attachment-id', {
        filename: 'new.jpg',
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('should soft delete attachment successfully', async () => {
      mockQueryBuilder.update.mockResolvedValue(1);

      const result = await repository.delete('attachment-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          deleted: expect.any(Date),
          updated: expect.any(Date),
        }),
      );
    });

    it('should return error on exception', async () => {
      mockQueryBuilder.update.mockRejectedValue(new Error('Delete failed'));

      const result = await repository.delete('attachment-id');

      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
