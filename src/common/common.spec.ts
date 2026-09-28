import { Test, TestingModule } from '@nestjs/testing';
import { KeyMaster } from './services/key.master';
import { DbService } from './services/db.service';
import { LoggerService } from './services/logger.service';

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
  });

  describe('DbService', () => {
    let service: DbService;

    const mockLoggerService = {
      createChildLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      }),
    };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DbService,
          {
            provide: LoggerService,
            useValue: mockLoggerService,
          },
        ],
      }).compile();

      service = module.get<DbService>(DbService);

      // Mock onModuleInit to prevent actual database connection in tests
      jest.spyOn(service, 'onModuleInit').mockResolvedValue(undefined);
    });

    afterEach(async () => {
      if (service) {
        await service.onModuleDestroy();
      }
      jest.clearAllMocks();
    });

    describe('query', () => {
      it('should return knex query builder', () => {
        const queryBuilder = service.query();

        expect(queryBuilder).toBeDefined();
        expect(typeof queryBuilder).toBe('function');
      });
    });

    describe('onModuleDestroy', () => {
      it('should call destroy without errors', async () => {
        await expect(service.onModuleDestroy()).resolves.not.toThrow();
      });
    });
  });
});
