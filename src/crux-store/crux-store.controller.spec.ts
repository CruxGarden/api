import { Test, TestingModule } from '@nestjs/testing';
import { StoreController } from './crux-store.controller';
import { StoreService } from './crux-store.service';
import { CruxService } from '../crux/crux.service';
import { AuthorService } from '../author/author.service';
import { UsageService } from '../usage/usage.service';
import { LoggerService } from '../common/services/logger.service';
import { AuthRequest } from '../common/types/interfaces';

describe('StoreController', () => {
  let controller: StoreController;
  let storeService: jest.Mocked<StoreService>;
  let usage: { noteStoreRequest: jest.Mock };

  const CRUX = 'crux-1';
  const now = new Date('2026-09-05T12:00:00Z');
  const anon = {} as AuthRequest;
  const alice = { account: { id: 'acct-alice' } } as AuthRequest;
  const owner = { account: { id: 'acct-owner' } } as AuthRequest;

  beforeEach(async () => {
    storeService = {
      get: jest.fn(),
      set: jest.fn(),
      increment: jest.fn(),
      delete: jest.fn(),
      deleteSlot: jest.fn(),
      list: jest.fn(),
      clearAll: jest.fn(),
    } as unknown as jest.Mocked<StoreService>;
    const cruxService = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: CRUX, authorId: 'author-owner' }),
    };
    const authorService = {
      findByAccountId: jest.fn(async (accountId: string) => {
        if (accountId === 'acct-alice') return { id: 'author-alice' };
        if (accountId === 'acct-owner') return { id: 'author-owner' };
        throw new Error('no author');
      }),
    };
    usage = { noteStoreRequest: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StoreController],
      providers: [
        { provide: StoreService, useValue: storeService },
        { provide: CruxService, useValue: cruxService },
        { provide: AuthorService, useValue: authorService },
        { provide: UsageService, useValue: usage },
        {
          provide: LoggerService,
          useValue: { createChildLogger: () => ({ warn: jest.fn() }) },
        },
      ],
    }).compile();

    controller = module.get(StoreController);
  });

  describe('GET /store/:cruxId/:key', () => {
    it('returns { value, mode, updatedAt } for a common key and meters a read', async () => {
      storeService.get.mockResolvedValue({
        value: ['a'],
        mode: 'common',
        updatedAt: now,
      } as any);
      expect(await controller.get(CRUX, 'board', anon)).toEqual({
        value: ['a'],
        mode: 'common',
        updatedAt: now,
      });
      expect(storeService.get).toHaveBeenCalledWith(CRUX, 'board', null);
      expect(usage.noteStoreRequest).toHaveBeenCalledWith(CRUX, 'read');
    });

    it('resolves the signed-in caller to their author id', async () => {
      storeService.get.mockResolvedValue(null);
      expect(await controller.get(CRUX, 'k', alice)).toEqual({ value: null });
      expect(storeService.get).toHaveBeenCalledWith(CRUX, 'k', 'author-alice');
    });
  });

  describe('PUT /store/:cruxId/:key', () => {
    it('passes mode common and the visitor through, then meters a write', async () => {
      storeService.set.mockResolvedValue({ value: ['a'] } as any);
      const body = await controller.set(
        CRUX,
        'board',
        { value: ['a'], mode: 'common' },
        alice,
      );
      expect(body).toEqual({ value: ['a'] });
      expect(storeService.set).toHaveBeenCalledWith(
        CRUX,
        'author-owner',
        'board',
        ['a'],
        'common',
        'author-alice',
      );
      expect(usage.noteStoreRequest).toHaveBeenCalledWith(CRUX, 'write');
    });

    it('defaults the mode to protected', async () => {
      storeService.set.mockResolvedValue({ value: 1 } as any);
      await controller.set(CRUX, 'k', { value: 1 }, alice);
      expect(storeService.set).toHaveBeenCalledWith(
        CRUX,
        'author-owner',
        'k',
        1,
        'protected',
        'author-alice',
      );
    });

    it('a token without an author counts as anonymous', async () => {
      storeService.set.mockResolvedValue({ value: 1 } as any);
      await controller.set(CRUX, 'k', { value: 1, mode: 'common' }, {
        account: { id: 'acct-ghost' },
      } as AuthRequest);
      expect(storeService.set).toHaveBeenCalledWith(
        CRUX,
        'author-owner',
        'k',
        1,
        'common',
        null,
      );
    });
  });

  describe('POST /store/:cruxId/:key/inc', () => {
    it('forwards by and mode with the caller', async () => {
      storeService.increment.mockResolvedValue(6);
      const body = await controller.increment(
        CRUX,
        'k',
        { by: 2, mode: 'common' },
        alice,
      );
      expect(body).toEqual({ value: 6 });
      expect(storeService.increment).toHaveBeenCalledWith(
        CRUX,
        'author-owner',
        'k',
        2,
        'author-alice',
        'common',
      );
      expect(usage.noteStoreRequest).toHaveBeenCalledWith(CRUX, 'write');
    });
  });

  describe('DELETE /store/:cruxId/:key', () => {
    it('the author deletes the whole key', async () => {
      await controller.deleteEntry(CRUX, 'k', owner);
      expect(storeService.delete).toHaveBeenCalledWith(CRUX, 'k');
      expect(storeService.deleteSlot).not.toHaveBeenCalled();
    });

    it('a visitor goes through deleteSlot with their author id', async () => {
      await controller.deleteEntry(CRUX, 'k', alice);
      expect(storeService.deleteSlot).toHaveBeenCalledWith(
        CRUX,
        'k',
        'author-alice',
      );
      expect(storeService.delete).not.toHaveBeenCalled();
      expect(usage.noteStoreRequest).toHaveBeenCalledWith(CRUX, 'write');
    });

    it('anonymous deletes go through deleteSlot with no visitor', async () => {
      await controller.deleteEntry(CRUX, 'k', anon);
      expect(storeService.deleteSlot).toHaveBeenCalledWith(CRUX, 'k', null);
    });
  });
});
