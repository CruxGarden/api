import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';
import { AccountRole } from '../common/types/enums';

describe('HomeController', () => {
  let controller: HomeController;
  let service: jest.Mocked<HomeService>;
  let dbService: jest.Mocked<DbService>;

  const mockHome = {
    id: 'home-id',
    key: 'home-key',
    name: 'Test Home',
    description: 'A test home',
    primary: true,
    type: 'personal',
    kind: 'garden',
    meta: { color: 'blue' },
    created: new Date(),
    updated: new Date(),
    deleted: null,
    toJSON: jest.fn().mockReturnThis(),
  };

  const mockAdminRequest: AuthRequest = {
    account: {
      id: 'account-123',
      email: 'admin@example.com',
      role: AccountRole.ADMIN,
    },
  } as any;

  const mockAuthorRequest: AuthRequest = {
    account: {
      id: 'account-456',
      email: 'author@example.com',
      role: AccountRole.AUTHOR,
    },
  } as any;

  const mockResponse = {
    setHeader: jest.fn(),
  } as any;

  beforeEach(async () => {
    const mockService = {
      findByKey: jest.fn(),
      findAllQuery: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mockDbService = {
      paginate: jest.fn(),
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
      controllers: [HomeController],
      providers: [
        { provide: HomeService, useValue: mockService },
        { provide: DbService, useValue: mockDbService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    controller = module.get<HomeController>(HomeController);
    service = module.get(HomeService);
    dbService = module.get(DbService);
  });

  describe('getAll', () => {
    it('should return paginated homes', async () => {
      const query = {} as any;
      service.findAllQuery.mockReturnValue(query);
      dbService.paginate.mockResolvedValue([mockHome]);

      const result = await controller.getAll(mockAdminRequest, mockResponse);

      expect(result).toEqual([mockHome]);
      expect(service.findAllQuery).toHaveBeenCalled();
      expect(dbService.paginate).toHaveBeenCalled();
    });
  });

  describe('getByKey', () => {
    it('should return a home by key', async () => {
      service.findByKey.mockResolvedValue(mockHome);

      const result = await controller.getByKey('home-key');

      expect(result).toEqual(mockHome);
      expect(service.findByKey).toHaveBeenCalledWith('home-key');
    });
  });

  describe('create', () => {
    const createDto = {
      name: 'Test Home',
      type: 'personal',
      kind: 'garden',
      primary: true,
    };

    it('should create a home successfully when user is admin', async () => {
      service.create.mockResolvedValue(mockHome);

      const result = await controller.create(createDto, mockAdminRequest);

      expect(result).toEqual(mockHome);
      expect(service.create).toHaveBeenCalledWith(createDto);
    });

    it('should throw ForbiddenException when user is not admin', async () => {
      await expect(
        controller.create(createDto, mockAuthorRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('update', () => {
    const updateDto = { name: 'Updated Home' };

    it('should update a home when user is admin', async () => {
      const updatedHome = { ...mockHome, name: 'Updated Home' };
      service.update.mockResolvedValue(updatedHome);

      const result = await controller.update(
        'home-key',
        updateDto,
        mockAdminRequest,
      );

      expect(result).toEqual(updatedHome);
      expect(service.update).toHaveBeenCalledWith('home-key', updateDto);
    });

    it('should throw ForbiddenException when user is not admin', async () => {
      await expect(
        controller.update('home-key', updateDto, mockAuthorRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('delete', () => {
    it('should delete a home when user is admin', async () => {
      service.delete.mockResolvedValue(null);

      const result = await controller.delete('home-key', mockAdminRequest);

      expect(result).toBeNull();
      expect(service.delete).toHaveBeenCalledWith('home-key');
    });

    it('should throw ForbiddenException when user is not admin', async () => {
      await expect(
        controller.delete('home-key', mockAuthorRequest),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('ensureAdmin', () => {
    it('should not throw when user is admin', () => {
      expect(() => {
        controller['ensureAdmin'](mockAdminRequest);
      }).not.toThrow();
    });

    it('should throw ForbiddenException when user is not admin', () => {
      expect(() => {
        controller['ensureAdmin'](mockAuthorRequest);
      }).toThrow(ForbiddenException);
    });
  });
});
