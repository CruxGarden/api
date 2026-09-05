import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { StoreService } from './crux-store.service';
import { StoreRepository } from './crux-store.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { success, failure } from '../common/helpers/repository-helpers';
import StoreRaw from './entities/crux-store-raw.entity';

describe('StoreService', () => {
  let service: StoreService;
  let repo: jest.Mocked<StoreRepository>;

  const CRUX = 'crux-1';
  const AUTHOR = 'author-owner';
  const ALICE = 'author-alice';
  const BOB = 'author-bob';
  const now = new Date('2026-09-05T12:00:00Z');

  const row = (over: Partial<StoreRaw>): StoreRaw => ({
    id: 'row',
    crux_id: CRUX,
    author_id: AUTHOR,
    visitor_id: null,
    key: 'k',
    value: 1,
    mode: 'public',
    created_at: now,
    updated_at: now,
    ...over,
  });

  beforeEach(async () => {
    repo = {
      findKeyModes: jest.fn().mockResolvedValue(success([])),
      findSharedEntry: jest.fn().mockResolvedValue(success(null)),
      findProtectedEntry: jest.fn().mockResolvedValue(success(null)),
      findAllByCrux: jest.fn(),
      upsertShared: jest.fn(),
      upsertProtected: jest.fn(),
      atomicIncrement: jest.fn(),
      deleteEntry: jest.fn().mockResolvedValue(success(undefined)),
      deleteKey: jest.fn().mockResolvedValue(success(undefined)),
      clearAllByCrux: jest.fn(),
      getStorageByAuthor: jest.fn(),
    } as unknown as jest.Mocked<StoreRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoreService,
        { provide: StoreRepository, useValue: repo },
        { provide: KeyMaster, useValue: { generateId: () => 'new-id' } },
        {
          provide: LoggerService,
          useValue: {
            createChildLogger: () => ({
              debug: jest.fn(),
              info: jest.fn(),
              warn: jest.fn(),
              error: jest.fn(),
            }),
          },
        },
      ],
    }).compile();

    service = module.get(StoreService);
  });

  describe('set — common', () => {
    it('needs a signed-in caller (401 with a plain message)', async () => {
      await expect(
        service.set(CRUX, AUTHOR, 'board', [], 'common', null),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: 'Common keys require a signed-in account to write',
      });
      expect(repo.upsertShared).not.toHaveBeenCalled();
    });

    it('writes the one shared value with mode common (no per-account slot)', async () => {
      repo.upsertShared.mockResolvedValue(
        success(row({ mode: 'common', value: ['a'], key: 'board' })),
      );
      const out = await service.set(
        CRUX,
        AUTHOR,
        'board',
        ['a'],
        'common',
        ALICE,
      );
      expect(repo.upsertShared).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        'board',
        ['a'],
        'common',
      );
      expect(repo.upsertProtected).not.toHaveBeenCalled();
      expect(out.mode).toBe('common');
      expect(out.visitorId).toBeNull();
    });

    it('a second account overwrites the same shared value', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      repo.upsertShared.mockResolvedValue(
        success(row({ mode: 'common', value: ['a', 'b'] })),
      );
      await expect(
        service.set(CRUX, AUTHOR, 'board', ['a', 'b'], 'common', BOB),
      ).resolves.toMatchObject({ value: ['a', 'b'] });
    });

    it('refuses to write a common value onto a protected key (409)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['protected']));
      await expect(
        service.set(CRUX, AUTHOR, 'prefs', {}, 'common', ALICE),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        message: 'Key "prefs" is protected; it cannot be written as common',
      });
      expect(repo.upsertShared).not.toHaveBeenCalled();
    });

    it('refuses to reopen a common key as public (409), signed in or not', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      await expect(
        service.set(CRUX, AUTHOR, 'board', 1, 'public', null),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.set(CRUX, AUTHOR, 'board', 1, 'public', ALICE),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.upsertShared).not.toHaveBeenCalled();
    });

    it('refuses a protected write onto a common key (409)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      await expect(
        service.set(CRUX, AUTHOR, 'board', 1, 'protected', ALICE),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('surfaces repository failures', async () => {
      repo.upsertShared.mockResolvedValue(failure(new Error('boom')));
      await expect(
        service.set(CRUX, AUTHOR, 'k', 1, 'common', ALICE),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('set — public and protected (unchanged)', () => {
    it('public writes need no caller and go to the shared row', async () => {
      repo.upsertShared.mockResolvedValue(success(row({ value: 5 })));
      await service.set(CRUX, AUTHOR, 'k', 5, 'public', null);
      expect(repo.upsertShared).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        'k',
        5,
        'public',
      );
    });

    it('protected writes need a caller (401) and go to their slot', async () => {
      await expect(
        service.set(CRUX, AUTHOR, 'k', 1, 'protected', null),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: 'Protected keys require authentication',
      });
      repo.upsertProtected.mockResolvedValue(
        success(row({ visitor_id: ALICE, mode: 'protected' })),
      );
      await service.set(CRUX, AUTHOR, 'k', 1, 'protected', ALICE);
      expect(repo.upsertProtected).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        ALICE,
        'k',
        1,
      );
    });
  });

  describe('get', () => {
    it('returns null for a key never written', async () => {
      await expect(service.get(CRUX, 'nope', null)).resolves.toBeNull();
    });

    it('common: anyone reads the shared value, exactly like a public read', async () => {
      repo.findSharedEntry.mockResolvedValue(
        success(row({ mode: 'common', value: ['a'] })),
      );
      const anon = await service.get(CRUX, 'board', null);
      expect(anon).toMatchObject({ mode: 'common', value: ['a'] });
      const signedIn = await service.get(CRUX, 'board', BOB);
      expect(signedIn).toMatchObject({ mode: 'common', value: ['a'] });
    });

    it('protected stays self-only: another visitor and anonymous get null', async () => {
      repo.findProtectedEntry.mockResolvedValue(success(null));
      repo.findSharedEntry.mockResolvedValue(success(null));
      await expect(service.get(CRUX, 'prefs', BOB)).resolves.toBeNull();
      await expect(service.get(CRUX, 'prefs', null)).resolves.toBeNull();
    });

    it('protected: returns the caller’s own slot', async () => {
      repo.findProtectedEntry.mockResolvedValue(
        success(row({ visitor_id: ALICE, mode: 'protected', value: { a: 1 } })),
      );
      const read = await service.get(CRUX, 'prefs', ALICE);
      expect(read).toMatchObject({ mode: 'protected', value: { a: 1 } });
      expect(repo.findProtectedEntry).toHaveBeenCalledWith(
        CRUX,
        'prefs',
        ALICE,
      );
    });
  });

  describe('increment', () => {
    it('common key: a signed-in caller increments the shared value', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      repo.findSharedEntry.mockResolvedValue(
        success(row({ mode: 'common', value: 3 })),
      );
      repo.atomicIncrement.mockResolvedValue(
        success(row({ mode: 'common', value: 5 })),
      );
      await expect(
        service.increment(CRUX, AUTHOR, 'plays', 2, ALICE),
      ).resolves.toBe(5);
      expect(repo.atomicIncrement).toHaveBeenCalledWith(CRUX, 'plays', 2, null);
      expect(repo.findProtectedEntry).not.toHaveBeenCalled();
    });

    it('common key: anonymous callers are refused (401)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      await expect(
        service.increment(CRUX, AUTHOR, 'plays', 1, null),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: 'Common keys require a signed-in account to write',
      });
      expect(repo.atomicIncrement).not.toHaveBeenCalled();
    });

    it('new key: creates it in the requested mode', async () => {
      repo.upsertShared.mockResolvedValue(
        success(row({ mode: 'common', value: 4 })),
      );
      await expect(
        service.increment(CRUX, AUTHOR, 'plays', 4, ALICE, 'common'),
      ).resolves.toBe(4);
      expect(repo.upsertShared).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        'plays',
        4,
        'common',
      );
    });

    it('new key with no mode keeps the legacy default (protected when signed in, public otherwise)', async () => {
      repo.upsertProtected.mockResolvedValue(
        success(row({ visitor_id: ALICE, mode: 'protected', value: 1 })),
      );
      await service.increment(CRUX, AUTHOR, 'k', 1, ALICE);
      expect(repo.upsertProtected).toHaveBeenCalled();
      repo.upsertShared.mockResolvedValue(success(row({ value: 1 })));
      await service.increment(CRUX, AUTHOR, 'k2', 1, null);
      expect(repo.upsertShared).toHaveBeenCalledWith(
        expect.anything(),
        CRUX,
        AUTHOR,
        'k2',
        1,
        'public',
      );
    });

    it('requested mode that disagrees with the key is a 409', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      await expect(
        service.increment(CRUX, AUTHOR, 'k', 1, ALICE, 'common'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('public key: a signed-in caller increments the shared value, not a private slot', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      repo.findSharedEntry.mockResolvedValue(success(row({ value: 9 })));
      repo.atomicIncrement.mockResolvedValue(success(row({ value: 10 })));
      await expect(
        service.increment(CRUX, AUTHOR, 'k', 1, ALICE),
      ).resolves.toBe(10);
      expect(repo.atomicIncrement).toHaveBeenCalledWith(CRUX, 'k', 1, null);
    });

    it('protected key: increments the caller’s own slot', async () => {
      repo.findKeyModes.mockResolvedValue(success(['protected']));
      repo.findProtectedEntry.mockResolvedValue(
        success(row({ visitor_id: ALICE, mode: 'protected', value: 1 })),
      );
      repo.atomicIncrement.mockResolvedValue(
        success(row({ visitor_id: ALICE, mode: 'protected', value: 2 })),
      );
      await expect(
        service.increment(CRUX, AUTHOR, 'k', 1, ALICE),
      ).resolves.toBe(2);
      expect(repo.atomicIncrement).toHaveBeenCalledWith(CRUX, 'k', 1, ALICE);
    });
  });

  describe('deleteSlot / delete', () => {
    it('common key: a signed-in caller deletes the shared value', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      await service.deleteSlot(CRUX, 'board', ALICE);
      expect(repo.deleteEntry).toHaveBeenCalledWith(CRUX, 'board', null);
      expect(repo.deleteKey).not.toHaveBeenCalled();
    });

    it('common key: anonymous delete is refused (401)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['common']));
      await expect(
        service.deleteSlot(CRUX, 'board', null),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repo.deleteEntry).not.toHaveBeenCalled();
    });

    it('protected key: deletes only the caller’s own slot', async () => {
      repo.findKeyModes.mockResolvedValue(success(['protected']));
      await service.deleteSlot(CRUX, 'k', ALICE);
      expect(repo.deleteEntry).toHaveBeenCalledWith(CRUX, 'k', ALICE);
      await expect(service.deleteSlot(CRUX, 'k', null)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('public key: anyone deletes the shared value', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      await service.deleteSlot(CRUX, 'k', null);
      expect(repo.deleteEntry).toHaveBeenCalledWith(CRUX, 'k', null);
    });

    it('missing key: no-op', async () => {
      await service.deleteSlot(CRUX, 'k', ALICE);
      expect(repo.deleteEntry).not.toHaveBeenCalled();
    });

    it('author delete removes every row of the key', async () => {
      await service.delete(CRUX, 'k');
      expect(repo.deleteKey).toHaveBeenCalledWith(CRUX, 'k');
    });
  });
});
