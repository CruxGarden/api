import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { StoreService, STORE_WRITE_NEEDS_ACCOUNT } from './crux-store.service';
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

  describe('every write needs a signed-in account', () => {
    it('set: public and protected alike are 401 with one plain message', async () => {
      for (const mode of ['public', 'protected'] as const) {
        await expect(
          service.set(CRUX, AUTHOR, 'k', 1, mode, null),
        ).rejects.toMatchObject({
          constructor: UnauthorizedException,
          message: STORE_WRITE_NEEDS_ACCOUNT,
        });
      }
      expect(repo.upsertShared).not.toHaveBeenCalled();
      expect(repo.upsertProtected).not.toHaveBeenCalled();
      // Refused before the key is even looked up — nothing to learn from a 409.
      expect(repo.findKeyModes).not.toHaveBeenCalled();
    });

    it('increment and deleteSlot: anonymous callers are refused (401)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      await expect(
        service.increment(CRUX, AUTHOR, 'hits', 1, null),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: STORE_WRITE_NEEDS_ACCOUNT,
      });
      await expect(
        service.deleteSlot(CRUX, 'hits', null),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: STORE_WRITE_NEEDS_ACCOUNT,
      });
      expect(repo.atomicIncrement).not.toHaveBeenCalled();
      expect(repo.deleteEntry).not.toHaveBeenCalled();
    });
  });

  describe('set — public', () => {
    it('writes the one shared value with mode public (no per-account slot)', async () => {
      repo.upsertShared.mockResolvedValue(
        success(row({ value: ['a'], key: 'board' })),
      );
      const out = await service.set(
        CRUX,
        AUTHOR,
        'board',
        ['a'],
        'public',
        ALICE,
      );
      expect(repo.upsertShared).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        'board',
        ['a'],
        'public',
      );
      expect(repo.upsertProtected).not.toHaveBeenCalled();
      expect(out.mode).toBe('public');
      expect(out.visitorId).toBeNull();
    });

    it('a second account overwrites the same shared value', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      repo.upsertShared.mockResolvedValue(success(row({ value: ['a', 'b'] })));
      await expect(
        service.set(CRUX, AUTHOR, 'board', ['a', 'b'], 'public', BOB),
      ).resolves.toMatchObject({ value: ['a', 'b'] });
    });

    it('accepts the deprecated alias common and stores public', async () => {
      repo.upsertShared.mockResolvedValue(success(row({ value: ['a'] })));
      const out = await service.set(
        CRUX,
        AUTHOR,
        'board',
        ['a'],
        'common' as any,
        ALICE,
      );
      expect(repo.upsertShared).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        'board',
        ['a'],
        'public',
      );
      expect(out.mode).toBe('public');
    });

    it('a row still marked common reads back as public', () => {
      expect(service.asStore(row({ mode: 'common' as any })).mode).toBe(
        'public',
      );
    });

    it('surfaces repository failures', async () => {
      repo.upsertShared.mockResolvedValue(failure(new Error('boom')));
      await expect(
        service.set(CRUX, AUTHOR, 'k', 1, 'public', ALICE),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('set — protected (unchanged)', () => {
    it('writes the caller’s own slot', async () => {
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

  describe('mode is fixed by the first write', () => {
    it('refuses to write a public value onto a protected key (409)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['protected']));
      await expect(
        service.set(CRUX, AUTHOR, 'prefs', {}, 'public', ALICE),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        message: 'Key "prefs" is protected; it cannot be written as public',
      });
      expect(repo.upsertShared).not.toHaveBeenCalled();
    });

    it('refuses a protected write onto a public key (409)', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      await expect(
        service.set(CRUX, AUTHOR, 'board', 1, 'protected', ALICE),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('the alias common agrees with a public key', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      repo.upsertShared.mockResolvedValue(success(row({ value: 2 })));
      await expect(
        service.set(CRUX, AUTHOR, 'board', 2, 'common' as any, ALICE),
      ).resolves.toMatchObject({ value: 2 });
    });
  });

  describe('get', () => {
    it('returns null for a key never written', async () => {
      await expect(service.get(CRUX, 'nope', null)).resolves.toBeNull();
    });

    it('public: anyone reads the shared value, signed in or not', async () => {
      repo.findSharedEntry.mockResolvedValue(success(row({ value: ['a'] })));
      const anon = await service.get(CRUX, 'board', null);
      expect(anon).toMatchObject({ mode: 'public', value: ['a'] });
      const signedIn = await service.get(CRUX, 'board', BOB);
      expect(signedIn).toMatchObject({ mode: 'public', value: ['a'] });
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
    it('public key: a signed-in caller increments the shared value, not a private slot', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      repo.findSharedEntry.mockResolvedValue(success(row({ value: 3 })));
      repo.atomicIncrement.mockResolvedValue(success(row({ value: 5 })));
      await expect(
        service.increment(CRUX, AUTHOR, 'plays', 2, ALICE),
      ).resolves.toBe(5);
      expect(repo.atomicIncrement).toHaveBeenCalledWith(CRUX, 'plays', 2, null);
      expect(repo.findProtectedEntry).not.toHaveBeenCalled();
    });

    it('new key: creates it in the requested mode (alias included)', async () => {
      repo.upsertShared.mockResolvedValue(success(row({ value: 4 })));
      await expect(
        service.increment(CRUX, AUTHOR, 'plays', 4, ALICE, 'public'),
      ).resolves.toBe(4);
      await expect(
        service.increment(CRUX, AUTHOR, 'plays2', 4, ALICE, 'common' as any),
      ).resolves.toBe(4);
      expect(repo.upsertShared).toHaveBeenLastCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        'plays2',
        4,
        'public',
      );
    });

    it('new key with no mode defaults to protected', async () => {
      repo.upsertProtected.mockResolvedValue(
        success(row({ visitor_id: ALICE, mode: 'protected', value: 1 })),
      );
      await service.increment(CRUX, AUTHOR, 'k', 1, ALICE);
      expect(repo.upsertProtected).toHaveBeenCalledWith(
        'new-id',
        CRUX,
        AUTHOR,
        ALICE,
        'k',
        1,
      );
      expect(repo.upsertShared).not.toHaveBeenCalled();
    });

    it('requested mode that disagrees with the key is a 409', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      await expect(
        service.increment(CRUX, AUTHOR, 'k', 1, ALICE, 'protected'),
      ).rejects.toBeInstanceOf(ConflictException);
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

    it('legacy key with both a public value and protected slots: the caller’s slot', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public', 'protected']));
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
    it('public key: a signed-in caller deletes the shared value', async () => {
      repo.findKeyModes.mockResolvedValue(success(['public']));
      await service.deleteSlot(CRUX, 'board', ALICE);
      expect(repo.deleteEntry).toHaveBeenCalledWith(CRUX, 'board', null);
      expect(repo.deleteKey).not.toHaveBeenCalled();
    });

    it('protected key: deletes only the caller’s own slot', async () => {
      repo.findKeyModes.mockResolvedValue(success(['protected']));
      await service.deleteSlot(CRUX, 'k', ALICE);
      expect(repo.deleteEntry).toHaveBeenCalledWith(CRUX, 'k', ALICE);
    });

    it('missing key: no-op for a signed-in caller', async () => {
      await service.deleteSlot(CRUX, 'k', ALICE);
      expect(repo.deleteEntry).not.toHaveBeenCalled();
    });

    it('author delete removes every row of the key', async () => {
      await service.delete(CRUX, 'k');
      expect(repo.deleteKey).toHaveBeenCalledWith(CRUX, 'k');
    });
  });
});
