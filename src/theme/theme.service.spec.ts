import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ThemeService } from './theme.service';
import { ThemeRepository } from './theme.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { TagService } from '../tag/tag.service';
import { ResourceType } from '../common/types/enums';

describe('ThemeService', () => {
  let service: ThemeService;
  let repository: jest.Mocked<ThemeRepository>;
  let tagService: jest.Mocked<TagService>;

  const mockThemeRaw = {
    id: 'theme-id-123',
    key: 'theme-key-abc',
    author_id: 'author-123',
    home_id: 'home-id-123',
    title: 'Test Theme',
    description: 'A test theme',
    type: 'nature',
    kind: 'light',
    system: false,
    meta: {
      palette: {
        light: {
          primary: '#4dd9b8',
          secondary: '#6de8ca',
          tertiary: '#3dbfa0',
          quaternary: '#357d6a',
        },
      },
      bloom: {
        light: { primary: { solid: '#4dd9b8' } },
      },
      content: {
        light: {
          backgroundColor: '#ffffff',
          textColor: '#000000',
          font: 'sans-serif',
        },
      },
    },
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

    const mockTagService = {
      getTags: jest.fn(),
      syncTags: jest.fn(),
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
        ThemeService,
        { provide: ThemeRepository, useValue: mockRepository },
        { provide: TagService, useValue: mockTagService },
        { provide: KeyMaster, useValue: mockKeyMaster },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<ThemeService>(ThemeService);
    repository = module.get(ThemeRepository);
    tagService = module.get(TagService);
  });

  describe('findById', () => {
    it('should return a theme when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });

      const result = await service.findById('theme-id-123');

      expect(result.id).toBe('theme-id-123');
      expect(repository.findBy).toHaveBeenCalledWith('id', 'theme-id-123');
    });

    it('should throw NotFoundException when theme not found', async () => {
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

      await expect(service.findById('theme-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey', () => {
    it('should return a theme when found', async () => {
      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });

      const result = await service.findByKey('theme-key-abc');

      expect(result.key).toBe('theme-key-abc');
      expect(repository.findBy).toHaveBeenCalledWith('key', 'theme-key-abc');
    });

    it('should throw NotFoundException when theme not found', async () => {
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

      await expect(service.findByKey('theme-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const createDto = {
      title: 'Test Theme',
      description: 'A test theme',
      type: 'nature',
      kind: 'light',
      authorId: 'author-123',
      meta: {
        palette: {
          light: { primary: '#4dd9b8' },
        },
      },
    };

    it('should create a theme successfully', async () => {
      repository.create.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });

      const result = await service.create(createDto);

      expect(result.id).toBe('theme-id-123');
      expect(repository.create).toHaveBeenCalledWith({
        ...createDto,
        id: 'generated-id',
        key: 'generated-key',
        system: false,
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
    const updateDto = { title: 'Updated Theme', description: 'Updated' };

    it('should update a theme successfully', async () => {
      const updatedTheme = { ...mockThemeRaw, title: 'Updated Theme' };
      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: updatedTheme,
        error: null,
      });

      const result = await service.update('theme-key-abc', updateDto);

      expect(result.title).toBe('Updated Theme');
      expect(repository.update).toHaveBeenCalledWith(
        mockThemeRaw.id,
        updateDto,
      );
    });

    it('should throw InternalServerErrorException on update error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });
      repository.update.mockResolvedValue({
        data: null,
        error: new Error('Update failed'),
      });

      await expect(service.update('theme-key', updateDto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('delete', () => {
    it('should delete a theme successfully', async () => {
      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({ data: null, error: null });

      const result = await service.delete('theme-key-abc');

      expect(result).toBeNull();
      expect(repository.delete).toHaveBeenCalledWith(mockThemeRaw.id);
    });

    it('should throw NotFoundException when theme not found', async () => {
      repository.findBy.mockResolvedValue({ data: null, error: null });

      await expect(service.delete('theme-key')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw InternalServerErrorException on delete error', async () => {
      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });
      repository.delete.mockResolvedValue({
        data: null,
        error: new Error('Delete failed'),
      });

      await expect(service.delete('theme-key')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getTags', () => {
    it('should delegate to tagService.getTags', async () => {
      const mockTags = [{ label: 'test-tag' }] as any;
      tagService.getTags.mockResolvedValue(mockTags);

      const result = await service.getTags('theme-key', 'filter');

      expect(result).toEqual(mockTags);
      expect(tagService.getTags).toHaveBeenCalledWith(
        ResourceType.THEME,
        'theme-key',
        'filter',
      );
    });
  });

  describe('syncTags', () => {
    it('should delegate to tagService.syncTags', async () => {
      const mockTags = [{ label: 'tag1' }, { label: 'tag2' }] as any;
      tagService.syncTags.mockResolvedValue(mockTags);

      const result = await service.syncTags(
        'theme-key',
        ['tag1', 'tag2'],
        'author-123',
      );

      expect(result).toEqual(mockTags);
      expect(tagService.syncTags).toHaveBeenCalledWith(
        ResourceType.THEME,
        'theme-key',
        ['tag1', 'tag2'],
        'author-123',
      );
    });
  });

  describe('asTheme', () => {
    it('should transform raw theme to entity', () => {
      const result = service.asTheme(mockThemeRaw);

      expect(result.id).toBe(mockThemeRaw.id);
      expect(result.authorId).toBe(mockThemeRaw.author_id);
      expect(result.system).toBe(mockThemeRaw.system);
      expect(result.meta).toEqual(mockThemeRaw.meta);
    });
  });

  describe('asThemes', () => {
    it('should transform array of raw themes to entities', () => {
      const result = service.asThemes([mockThemeRaw]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockThemeRaw.id);
    });
  });

  describe('meta validation', () => {
    it('should reject theme without meta', async () => {
      const invalidDto = {
        title: 'No Meta Theme',
        authorId: 'author-123',
      };

      await expect(service.create(invalidDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject empty meta object', async () => {
      const invalidDto = {
        title: 'Empty Meta',
        meta: {},
        authorId: 'author-123',
      };

      await expect(service.create(invalidDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept valid meta with gradients', async () => {
      const createDtoWithGradient = {
        title: 'Gradient Theme',
        meta: {
          bloom: {
            light: {
              primary: {
                gradient: {
                  angle: 135,
                  stops: [
                    { color: '#4dd9b8', offset: '0%' },
                    { color: '#3dbfa0', offset: '100%' },
                  ],
                },
              },
            },
          },
        },
        authorId: 'author-123',
      };

      repository.create.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });

      const result = await service.create(createDtoWithGradient);
      expect(result.id).toBe('theme-id-123');
    });

    it('should reject meta with invalid hex color', async () => {
      const invalidDto = {
        title: 'Invalid Theme',
        meta: {
          palette: {
            light: { primary: 'not-a-hex' },
          },
        },
        authorId: 'author-123',
      };

      await expect(service.create(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject meta with gradient containing id field', async () => {
      const invalidDto = {
        title: 'Invalid Gradient',
        meta: {
          bloom: {
            light: {
              primary: {
                gradient: {
                  id: 'should-not-be-here',
                  angle: 135,
                  stops: [
                    { color: '#4dd9b8', offset: '0%' },
                    { color: '#3dbfa0', offset: '100%' },
                  ],
                },
              },
            },
          },
        },
        authorId: 'author-123',
      };

      await expect(service.create(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject meta with invalid gradient stop offset format', async () => {
      const invalidDto = {
        title: 'Invalid Offset',
        meta: {
          bloom: {
            light: {
              primary: {
                gradient: {
                  angle: 135,
                  stops: [
                    { color: '#4dd9b8', offset: '0' }, // Missing %
                    { color: '#3dbfa0', offset: '100%' },
                  ],
                },
              },
            },
          },
        },
        authorId: 'author-123',
      };

      await expect(service.create(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject meta with invalid font type', async () => {
      const invalidDto = {
        title: 'Invalid Font',
        meta: {
          content: {
            light: { font: 'comic-sans' }, // Not in enum
          },
        },
        authorId: 'author-123',
      };

      await expect(service.create(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept meta with all valid enum values', async () => {
      const validDto = {
        title: 'Valid Enums',
        meta: {
          content: {
            light: {
              font: 'serif' as const,
              borderStyle: 'dashed' as const,
            },
          },
          controls: {
            light: {
              linkUnderlineStyle: 'always' as const,
              buttonBorderStyle: 'dotted' as const,
            },
          },
        },
        authorId: 'author-123',
      };

      repository.create.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });

      const result = await service.create(validDto);
      expect(result.id).toBe('theme-id-123');
    });

    it('should validate meta on update', async () => {
      const invalidUpdateDto = {
        meta: {
          palette: {
            light: { primary: 'invalid-color' },
          },
        },
      };

      repository.findBy.mockResolvedValue({
        data: mockThemeRaw,
        error: null,
      });

      await expect(
        service.update('theme-key', invalidUpdateDto),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
