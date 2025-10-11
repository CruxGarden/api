import { Test, TestingModule } from '@nestjs/testing';
import { KeyMaster } from './services/key.master';
import { DbService } from './services/db.service';
import { Request, Response } from 'express';

describe('Common Module', () => {
  describe('KeyMaster', () => {
    let keyMaster: KeyMaster;

    beforeEach(() => {
      keyMaster = new KeyMaster();
    });

    describe('generateId', () => {
      it('should generate a valid UUID', () => {
        const id = keyMaster.generateId();

        expect(id).toBeTruthy();
        expect(typeof id).toBe('string');
        // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });

      it('should generate unique IDs', () => {
        const id1 = keyMaster.generateId();
        const id2 = keyMaster.generateId();

        expect(id1).not.toBe(id2);
      });

      it('should generate IDs with correct length', () => {
        const id = keyMaster.generateId();

        expect(id.length).toBe(36); // UUID format: 32 chars + 4 dashes
      });
    });

    describe('generateKey', () => {
      it('should generate key with default length', () => {
        const key = keyMaster.generateKey();

        expect(key).toBeTruthy();
        expect(typeof key).toBe('string');
        expect(key.length).toBe(16); // DEFAULT_KEY_LENGTH
      });

      it('should generate key with custom length', () => {
        const key = keyMaster.generateKey(24);

        expect(key).toBeTruthy();
        expect(key.length).toBe(24);
      });

      it('should generate short keys', () => {
        const key = keyMaster.generateKey(5);

        expect(key.length).toBe(5);
      });

      it('should generate long keys', () => {
        const key = keyMaster.generateKey(32);

        expect(key.length).toBe(32);
      });

      it('should generate unique keys', () => {
        const key1 = keyMaster.generateKey();
        const key2 = keyMaster.generateKey();

        expect(key1).not.toBe(key2);
      });

      it('should use URL-safe characters', () => {
        const key = keyMaster.generateKey(100);

        // Should only contain A-Z, a-z, 0-9, -, _
        expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      it('should handle length of 1', () => {
        const key = keyMaster.generateKey(1);

        expect(key.length).toBe(1);
      });
    });
  });

  describe('DbService', () => {
    let service: DbService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [DbService],
      }).compile();

      service = module.get<DbService>(DbService);
    });

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    describe('query', () => {
      it('should return knex query builder', () => {
        const queryBuilder = service.query();

        expect(queryBuilder).toBeDefined();
        expect(typeof queryBuilder).toBe('function');
      });
    });

    describe('paginate', () => {
      it('should paginate query results with model transformation', async () => {
        const mockData = [
          { id: '1', name: 'Test 1' },
          { id: '2', name: 'Test 2' },
        ];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 1,
            perPage: 25,
            total: 2,
            lastPage: 1,
          },
        };

        class TestModel {
          id: string;
          name: string;
          constructor(data: any) {
            this.id = data.id;
            this.name = data.name;
          }
        }

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: {},
          originalUrl: '/test',
        } as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        const result = await service.paginate({
          model: TestModel,
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        expect(result).toHaveLength(2);
        expect(result[0]).toBeInstanceOf(TestModel);
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Link',
          expect.any(String),
        );
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Pagination',
          JSON.stringify({
            currentPage: 1,
            perPage: 25,
            total: 2,
          }),
        );
      });

      it('should paginate without model transformation', async () => {
        const mockData = [
          { id: '1', name: 'Test 1' },
          { id: '2', name: 'Test 2' },
        ];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 1,
            perPage: 25,
            total: 2,
            lastPage: 1,
          },
        };

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: {},
          originalUrl: '/test',
        } as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        const result = await service.paginate({
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        expect(result).toEqual(mockData);
      });

      it('should handle custom page and perPage parameters', async () => {
        const mockData = [{ id: '3', name: 'Test 3' }];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 2,
            perPage: 10,
            total: 15,
            lastPage: 2,
          },
        };

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: { page: '2', perPage: '10' },
          originalUrl: '/test?page=2&perPage=10',
        } as any as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        await service.paginate({
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        expect(mockQuery.paginate).toHaveBeenCalledWith({
          perPage: 10,
          currentPage: 2,
          isLengthAware: true,
        });
      });

      it('should handle per_page parameter (snake_case)', async () => {
        const mockData = [{ id: '1', name: 'Test' }];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 1,
            perPage: 50,
            total: 1,
            lastPage: 1,
          },
        };

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: { per_page: '50' },
          originalUrl: '/test?per_page=50',
        } as any as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        await service.paginate({
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        expect(mockQuery.paginate).toHaveBeenCalledWith({
          perPage: 50,
          currentPage: 1,
          isLengthAware: true,
        });
      });

      it('should set correct pagination link headers', async () => {
        const mockData = [{ id: '2' }];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 2,
            perPage: 10,
            total: 30,
            lastPage: 3,
          },
        };

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: { page: '2', perPage: '10' },
          originalUrl: '/test?page=2&perPage=10',
        } as any as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        await service.paginate({
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        const setHeaderCalls = (mockResponse.setHeader as jest.Mock).mock.calls;
        const linkHeader = setHeaderCalls.find((call) => call[0] === 'Link');
        expect(linkHeader).toBeDefined();
        // The format-link-header library combines rels, check for presence
        expect(linkHeader[1]).toContain('first');
        expect(linkHeader[1]).toContain('prev');
        expect(linkHeader[1]).toContain('next');
        expect(linkHeader[1]).toContain('last');
      });

      it('should handle first page edge case', async () => {
        const mockData = [{ id: '1' }];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 1,
            perPage: 10,
            total: 30,
            lastPage: 3,
          },
        };

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: { page: '1' },
          originalUrl: '/test?page=1',
        } as any as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        await service.paginate({
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        const setHeaderCalls = (mockResponse.setHeader as jest.Mock).mock.calls;
        const linkHeader = setHeaderCalls.find((call) => call[0] === 'Link');
        expect(linkHeader).toBeDefined();
        // prev should point to page 1 when on first page
        expect(linkHeader[1]).toContain('page=1');
      });

      it('should handle last page edge case', async () => {
        const mockData = [{ id: '3' }];

        const mockPaginationResult = {
          data: mockData,
          pagination: {
            currentPage: 3,
            perPage: 10,
            total: 30,
            lastPage: 3,
          },
        };

        const mockQuery = {
          paginate: jest.fn().mockResolvedValue(mockPaginationResult),
        } as any;

        const mockRequest = {
          query: { page: '3' },
          originalUrl: '/test?page=3',
        } as any as Request;

        const mockResponse = {
          setHeader: jest.fn(),
        } as any as Response;

        process.env.BASE_URL = 'http://localhost:3000';

        await service.paginate({
          query: mockQuery,
          request: mockRequest,
          response: mockResponse,
        });

        const setHeaderCalls = (mockResponse.setHeader as jest.Mock).mock.calls;
        const linkHeader = setHeaderCalls.find((call) => call[0] === 'Link');
        expect(linkHeader).toBeDefined();
        // next should point to page 3 (last page) when on last page
        expect(linkHeader[1]).toContain('page=3');
      });
    });

    describe('onModuleDestroy', () => {
      it('should call destroy without errors', async () => {
        await expect(service.onModuleDestroy()).resolves.not.toThrow();
      });
    });
  });
});
