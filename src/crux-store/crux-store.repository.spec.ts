import { Test, TestingModule } from '@nestjs/testing';
import { StoreRepository } from './crux-store.repository';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

describe('StoreRepository', () => {
  let repository: StoreRepository;
  let qb: any;

  beforeEach(async () => {
    qb = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn(),
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn(),
      insert: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      merge: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
      raw: jest.fn().mockReturnValue('RAW'),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoreRepository,
        { provide: DbService, useValue: { query: () => qb } },
        {
          provide: LoggerService,
          useValue: {
            createChildLogger: () => ({ error: jest.fn(), debug: jest.fn() }),
          },
        },
      ],
    }).compile();
    repository = module.get(StoreRepository);
  });

  describe('findKeyModes', () => {
    it('returns the distinct modes of a key', async () => {
      qb.distinct.mockResolvedValue([{ mode: 'common' }]);
      const res = await repository.findKeyModes('c', 'k');
      expect(res.data).toEqual(['common']);
      expect(qb.where).toHaveBeenCalledWith('crux_id', 'c');
      expect(qb.where).toHaveBeenCalledWith('key', 'k');
      expect(qb.distinct).toHaveBeenCalledWith('mode');
    });

    it('is empty for a key never written', async () => {
      qb.distinct.mockResolvedValue([]);
      expect((await repository.findKeyModes('c', 'k')).data).toEqual([]);
    });

    it('returns the error on failure', async () => {
      qb.distinct.mockRejectedValue(new Error('db'));
      const res = await repository.findKeyModes('c', 'k');
      expect(res.data).toBeNull();
      expect(res.error).toBeTruthy();
    });
  });

  describe('upsertShared', () => {
    it('inserts the shared row (no visitor) with the given mode and never merges the mode', async () => {
      const row = { id: 'r', mode: 'common', visitor_id: null };
      qb.first.mockResolvedValue(row);
      const res = await repository.upsertShared(
        'id',
        'c',
        'a',
        'k',
        { x: 1 },
        'common',
      );
      expect(res.data).toBe(row);
      expect(qb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          visitor_id: null,
          mode: 'common',
          value: JSON.stringify({ x: 1 }),
        }),
      );
      expect(qb.merge).toHaveBeenCalledWith(
        expect.not.objectContaining({ mode: expect.anything() }),
      );
      expect(qb.whereNull).toHaveBeenCalledWith('visitor_id');
    });
  });

  describe('upsertProtected', () => {
    it('inserts the caller’s slot with mode protected', async () => {
      qb.first.mockResolvedValue({ id: 'r', mode: 'protected' });
      await repository.upsertProtected('id', 'c', 'a', 'v', 'k', 1);
      expect(qb.insert).toHaveBeenCalledWith(
        expect.objectContaining({ visitor_id: 'v', mode: 'protected' }),
      );
    });
  });

  describe('deleteKey', () => {
    it('deletes every row of the key regardless of slot', async () => {
      const res = await repository.deleteKey('c', 'k');
      expect(res.error).toBeNull();
      expect(qb.where).toHaveBeenCalledWith('crux_id', 'c');
      expect(qb.where).toHaveBeenCalledWith('key', 'k');
      expect(qb.whereNull).not.toHaveBeenCalled();
      expect(qb.del).toHaveBeenCalled();
    });
  });
});
