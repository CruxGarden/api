import { PUBLICATION_META_KEYS } from '../common/publish/publication-state';
import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CruxService, CRUX_TAKEN_DOWN } from './crux.service';
import { CruxRepository } from './crux.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { DimensionService } from '../dimension/dimension.service';
import { TagService } from '../tag/tag.service';
import { ArtifactService } from '../artifact/artifact.service';
import { StoreService } from '../common/services/store.service';
import { DimensionType, ResourceType } from '../common/types/enums';
import { PublishStorageService } from '../common/services/publish-storage.service';
import { UsageService } from '../usage/usage.service';
import { LimitsService } from '../usage/limits.service';
import { NotificationsService } from '../usage/notifications.service';
import { DomainsService } from '../domains/domains.service';

describe('CruxService', () => {
  let service: CruxService;
  let repository: jest.Mocked<CruxRepository>;
  let dimensionService: jest.Mocked<DimensionService>;
  let tagService: jest.Mocked<TagService>;

  const mockCruxRaw = {
    id: 'crux-id-123',
    slug: 'test-crux',
    title: 'Test Crux',
    description: 'A test crux',
    data: '{}',
    type: 'note',
    status: 'living' as const,
    visibility: 'public' as const,
    author_id: 'author-123',
    home_id: 'home-id-123',
    meta: null,
    created: new Date(),
    updated: new Date(),
    deleted: null,
  };

  beforeEach(async () => {
    const mockRepository = {
      findBy: jest.fn(),
      findActiveTakedown: jest
        .fn()
        .mockResolvedValue({ data: undefined, error: null }),
      createTakedown: jest.fn(),
      liftTakedown: jest.fn(),
      beginPublicationRemoval: jest.fn(),
      findByIdIncludingDeleted: jest
        .fn()
        .mockResolvedValue({ data: null, error: null }),
      findByAuthorAndSlug: jest.fn(),
      findAllByAuthorQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockDimensionService = {
      findBySourceIdAndTypeQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const mockTagService = {
      getTags: jest.fn(),
      syncTags: jest.fn(),
    };

    const mockPublishStorage = {
      ensureBucket: jest.fn().mockResolvedValue('crux-x'),
      putFiles: jest.fn().mockResolvedValue({ bytes: 0, files: 0 }),
      deleteBucket: jest.fn().mockResolvedValue(undefined),
    };
    const mockUsageService = {
      recordStorage: jest.fn().mockResolvedValue(undefined),
      clearStorage: jest.fn().mockResolvedValue(undefined),
    };
    const mockDomainsService = {
      removeAllForCrux: jest.fn().mockResolvedValue(undefined),
    };
    const mockArtifactService = {
      findByResource: jest.fn(),
      createWithFile: jest.fn(),
      findById: jest.fn(),
      downloadArtifact: jest.fn(),
    };

    const mockKeyMaster = {
      generateId: jest.fn().mockReturnValue('generated-id'),
    };

    const mockLoggerService = {
      createChildLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    };

    const mockStoreService = {
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      invalidateCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CruxService,
        { provide: CruxRepository, useValue: mockRepository },
        { provide: DimensionService, useValue: mockDimensionService },
        { provide: TagService, useValue: mockTagService },
        { provide: ArtifactService, useValue: mockArtifactService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: StoreService, useValue: mockStoreService },
        { provide: PublishStorageService, useValue: mockPublishStorage },
        { provide: UsageService, useValue: mockUsageService },
        { provide: LimitsService, useValue: { assertStorage: jest.fn() } },
        { provide: NotificationsService, useValue: { afterWrite: jest.fn() } },
        { provide: DomainsService, useValue: mockDomainsService },
      ],
    }).compile();

    service = module.get<CruxService>(CruxService);
    repository = module.get(CruxRepository);
    dimensionService = module.get(DimensionService);
    tagService = module.get(TagService);
  });

  describe('findById', () => {
    it('should return a crux when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.findById('crux-id-123');

      expect(result.id).toBe('crux-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'crux-id-123');
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.findById('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByAuthorAndSlug', () => {
    it('should return a crux when found', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.findByAuthorAndSlug(
        'author-123',
        'test-crux',
      );

      expect(result.slug).toBe('test-crux');
      expect(repository.findByAuthorAndSlug).toHaveBeenCalledWith(
        'author-123',
        'test-crux',
      );
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });

      await expect(
        service.findByAuthorAndSlug('author-123', 'invalid-slug'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    const createDto = {
      slug: 'test-crux',
      title: 'Test Crux',
      data: '{}',
      type: 'note',
      authorId: 'author-123',
    };

    it('refuses a hosted slug collision without deleting or creating anything', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      await expect(service.create({ ...createDto })).rejects.toThrow(
        ConflictException,
      );
      expect(repository.delete).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('should create a crux successfully', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.create.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('crux-id-123');
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...createDto,
          id: 'generated-id',
          status: 'living',
          visibility: 'unlisted',
          discoverable: false,
        }),
      );
      expect(createDto).not.toHaveProperty('id');
    });

    it('should throw InternalServerErrorException on create error', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.create.mockResolvedValue({
        data: null,
        error: new Error('Create failed'),
      });

      await expect(service.create(createDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('ADR 0084 conversation publication', () => {
    const conversation = {
      summary: { purpose: 'A game' },
      messages: [
        { role: 'user', content: 'make a game' },
        {
          role: 'user',
          content: 'my address is 1 Elm St',
          excludedFromPublish: true,
        },
      ],
      personaSnapshots: { p: { systemPrompt: 'persona prompt' } },
    };

    it('creation stores no conversation when the creator kept it private', async () => {
      repository.findByAuthorAndSlug.mockResolvedValue({
        data: null,
        error: null,
      });
      repository.create.mockResolvedValue({ data: mockCruxRaw, error: null });
      await service.create({
        slug: 'private-chat',
        data: '',
        type: 'note',
        authorId: 'author-123',
        meta: { ...conversation, conversationPublished: false },
      });
      const stored = repository.create.mock.calls[0][0].meta;
      expect(stored).not.toHaveProperty('messages');
      expect(stored).not.toHaveProperty('personaSnapshots');
      expect(stored).toMatchObject({
        conversationPublished: false,
        summary: { purpose: 'A game' },
      });
    });

    it('updates drop excluded messages even from a client that sent them', async () => {
      repository.findBy.mockResolvedValue({ data: mockCruxRaw, error: null });
      repository.update.mockResolvedValue({ data: mockCruxRaw, error: null });
      await service.update('crux-id-123', {
        meta: { ...conversation, conversationPublished: true },
      });
      const stored = repository.update.mock.calls[0][1].meta;
      expect(stored.messages).toEqual([
        { role: 'user', content: 'make a game' },
      ]);
      expect(JSON.stringify(stored)).not.toContain('Elm St');

      await service.update('crux-id-123', {
        meta: { ...conversation, conversationPublished: false },
      });
      expect(repository.update.mock.calls[1][1].meta).not.toHaveProperty(
        'messages',
      );
    });
  });

  describe('update', () => {
    const updateDto = { title: 'Updated Title', description: 'Updated' };

    it('should update a crux successfully', async () => {
      const updatedCrux = { ...mockCruxRaw, title: 'Updated Title' };
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedCrux,
        error: null,
      });

      const result = await service.update('crux-id-123', updateDto);

      expect(result.title).toBe('Updated Title');
      expect(repository.update).toHaveBeenCalledWith(
        mockCruxRaw.id,
        updateDto,
        PUBLICATION_META_KEYS,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('crux-id-123', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a crux successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('crux-id-123');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(
        mockCruxRaw.id,
        undefined,
        false,
      );
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.delete('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('crux-id-123')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getDimensionsQuery', () => {
    it('should delegate to dimensionService', () => {
      const mockQuery = {} as any;
      dimensionService.findBySourceIdAndTypeQuery.mockReturnValue(mockQuery);

      const result = service.getDimensionsQuery('crux-123', DimensionType.GATE);

      expect(result).toBe(mockQuery);
      expect(dimensionService.findBySourceIdAndTypeQuery).toHaveBeenCalledWith(
        'crux-123',
        DimensionType.GATE,
        false,
        true,
      );
    });
  });

  describe('createDimension', () => {
    const createDimensionDto = {
      targetId: 'target-crux-123',
      type: DimensionType.GATE,
    };

    it('should create a dimension successfully', async () => {
      const mockDimension = { id: 'dim-123' } as any;
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      dimensionService.create.mockResolvedValue(mockDimension);

      const result = await service.createDimension(
        'crux-id-123',
        createDimensionDto,
      );

      expect(result).toBe(mockDimension);
      expect(dimensionService.create).toHaveBeenCalledWith({
        ...createDimensionDto,
        sourceId: mockCruxRaw.id,
      });
    });

    it('should throw NotFoundException when crux not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(
        service.createDimension('invalid-id', createDimensionDto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateDimension', () => {
    it('should delegate to dimensionService.update', async () => {
      const updateDto = { type: DimensionType.GARDEN };
      const mockDimension = { id: 'dim-123' } as any;
      dimensionService.update.mockResolvedValue(mockDimension);

      const result = await service.updateDimension('dim-123', updateDto);

      expect(result).toBe(mockDimension);
      expect(dimensionService.update).toHaveBeenCalledWith(
        'dim-123',
        updateDto,
      );
    });
  });

  describe('getTags', () => {
    it('should delegate to tagService.getTags', async () => {
      const mockTags = [{ label: 'test-tag' }] as any;
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      tagService.getTags.mockResolvedValue(mockTags);

      const result = await service.getTags('crux-id-123', 'filter');

      expect(result).toEqual(mockTags);
      expect(repository.findBy).toHaveBeenCalledWith('id', 'crux-id-123');
      expect(tagService.getTags).toHaveBeenCalledWith(
        ResourceType.CRUX,
        mockCruxRaw.id,
        'filter',
      );
    });
  });

  describe('syncTags', () => {
    it('should delegate to tagService.syncTags', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      repository.findBy.mockResolvedValue({
        data: mockCruxRaw,
        error: null,
      });
      tagService.syncTags.mockResolvedValue(mockTags);

      const result = await service.syncTags(
        'crux-id-123',
        ['tag1', 'tag2'],
        'author-123',
      );

      expect(result).toEqual(mockTags);
      expect(repository.findBy).toHaveBeenCalledWith('id', 'crux-id-123');
      expect(tagService.syncTags).toHaveBeenCalledWith(
        ResourceType.CRUX,
        mockCruxRaw.id,
        ['tag1', 'tag2'],
        'author-123',
      );
    });
  });

  describe('asCrux', () => {
    it('should transform raw crux to entity', () => {
      const result = service.asCrux(mockCruxRaw);

      expect(result.id).toBe(mockCruxRaw.id);
      expect(result.authorId).toBe(mockCruxRaw.author_id);
    });
  });

  describe('asCruxes', () => {
    it('should transform array of raw cruxes to entities', () => {
      const result = service.asCruxes([mockCruxRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockCruxRaw.id);
    });
  });
  describe('takedowns', () => {
    const takedownRaw = {
      id: 'takedown-1',
      crux_id: 'crux-id-123',
      author_id: 'author-123',
      reason: 'Illegal content',
      report_id: null,
      created_by: 'operator-1',
      lifted: null,
      lifted_by: null,
      created: new Date(),
      updated: new Date(),
      deleted: null,
    };
    const routing = process.env.PUBLISH_REVISION_ROUTING;
    afterEach(() => {
      process.env.PUBLISH_REVISION_ROUTING = routing;
    });

    it('records the takedown before unpublishing through the ordinary path', async () => {
      repository.findBy.mockResolvedValue({ data: mockCruxRaw, error: null });
      repository.createTakedown.mockResolvedValue({
        data: takedownRaw,
        error: null,
      });
      const order: string[] = [];
      repository.createTakedown.mockImplementationOnce(async () => {
        order.push('record');
        return { data: takedownRaw, error: null };
      });
      const unpublish = jest
        .spyOn(service, 'unpublishCrux')
        .mockImplementation(async () => {
          order.push('unpublish');
          return service.asCrux(mockCruxRaw);
        });

      const result = await service.takeDownCrux(
        'crux-id-123',
        'operator-1',
        'Illegal content',
        'report-1',
      );

      expect(order).toEqual(['record', 'unpublish']);
      expect(repository.createTakedown).toHaveBeenCalledWith({
        id: 'generated-id',
        cruxId: 'crux-id-123',
        authorId: mockCruxRaw.author_id,
        reason: 'Illegal content',
        reportId: 'report-1',
        createdBy: 'operator-1',
      });
      expect(unpublish).toHaveBeenCalledWith('crux-id-123');
      expect(result.cruxId).toBe('crux-id-123');
    });

    it('keeps the takedown when the teardown fails, and retries without a second record', async () => {
      repository.findBy.mockResolvedValue({ data: mockCruxRaw, error: null });
      repository.createTakedown.mockResolvedValue({
        data: takedownRaw,
        error: null,
      });
      const unpublish = jest
        .spyOn(service, 'unpublishCrux')
        .mockRejectedValueOnce(new Error('storage down'))
        .mockResolvedValueOnce(service.asCrux(mockCruxRaw));

      await expect(
        service.takeDownCrux('crux-id-123', 'operator-1', 'Illegal content'),
      ).rejects.toThrow('storage down');
      repository.findActiveTakedown.mockResolvedValue({
        data: takedownRaw,
        error: null,
      });
      await service.takeDownCrux(
        'crux-id-123',
        'operator-1',
        'Illegal content',
      );

      expect(repository.createTakedown).toHaveBeenCalledTimes(1);
      expect(unpublish).toHaveBeenCalledTimes(2);
    });

    it('blocks an id whose crux is already gone without unpublishing', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });
      repository.createTakedown.mockResolvedValue({
        data: { ...takedownRaw, author_id: null },
        error: null,
      });
      const unpublish = jest.spyOn(service, 'unpublishCrux');

      await service.takeDownCrux('crux-id-123', 'operator-1', 'Spam');

      expect(repository.createTakedown).toHaveBeenCalled();
      expect(unpublish).not.toHaveBeenCalled();
    });

    it('refuses to publish a taken-down crux with 403', async () => {
      process.env.PUBLISH_REVISION_ROUTING = '1';
      repository.findBy.mockResolvedValue({ data: mockCruxRaw, error: null });
      repository.findActiveTakedown.mockResolvedValue({
        data: takedownRaw,
        error: null,
      });

      await expect(
        service.publishCrux('crux-id-123', [], [], 'author-123'),
      ).rejects.toMatchObject({ status: 403, message: CRUX_TAKEN_DOWN });
    });

    it('refuses to publish when the takedown list cannot be read', async () => {
      process.env.PUBLISH_REVISION_ROUTING = '1';
      repository.findBy.mockResolvedValue({ data: mockCruxRaw, error: null });
      repository.findActiveTakedown.mockResolvedValue({
        data: null,
        error: new Error('db down'),
      });

      await expect(
        service.publishCrux('crux-id-123', [], [], 'author-123'),
      ).rejects.toMatchObject({ status: 500 });
    });

    it('refuses to recreate a taken-down crux id', async () => {
      repository.findActiveTakedown.mockResolvedValue({
        data: takedownRaw,
        error: null,
      });

      await expect(
        service.create({ id: 'crux-id-123', slug: 'again' } as any, 'author'),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('lifts an active takedown and 404s when there is none', async () => {
      repository.liftTakedown.mockResolvedValueOnce({
        data: { ...takedownRaw, lifted: new Date(), lifted_by: 'operator-2' },
        error: null,
      });
      const lifted = await service.liftTakedown('crux-id-123', 'operator-2');
      expect(lifted.liftedBy).toBe('operator-2');

      repository.liftTakedown.mockResolvedValueOnce({
        data: undefined,
        error: null,
      });
      await expect(
        service.liftTakedown('crux-id-123', 'operator-2'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
