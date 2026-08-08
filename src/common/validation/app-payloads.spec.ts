/**
 * The payloads the app actually sends, run through the global ValidationPipe.
 *
 * Turning validation on (main.ts) made every DTO decorator load-bearing for
 * the first time. `CreateCruxDto.data` was `@IsNotEmpty()` while the app sends
 * `data: ''` for every workspace crux — so the first publish of any crux 400'd
 * with "data should not be empty". These cases pin the real payloads so a
 * decorator change can't quietly break the publish path again.
 *
 * When the app changes what it sends, change the fixture here in the same
 * commit — that is the point of the file.
 */
import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { CreateCruxDto } from '../../crux/dto/create-crux.dto';
import { UpdateCruxDto } from '../../crux/dto/update-crux.dto';
import { UpdateAuthorDto } from '../../author/dto/update-author.dto';
import { SyncTagsDto } from '../../tag/dto/sync-tags.dto';

// Same options as main.ts — kept in sync deliberately.
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidUnknownValues: false,
});

const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

/** The crux fields publish.ts sends (cruxUpsertFields + id on create). */
const cruxUpsertFields = {
  title: 'My Home Page',
  slug: 'my-home-page-mfa3k1',
  description: '',
  data: '',
  type: 'workspace',
  kind: 'webapp',
  discoverable: false,
  meta: {
    settings: { model: 'claude-sonnet-5', activeBranch: null },
    messages: [{ role: 'assistant', content: 'Welcome' }],
    personaSnapshots: { abc123: { name: 'Keeper' } },
    publishedFingerprints: { 'index.html': 'deadbeef' },
  },
};

describe('app payloads survive the global ValidationPipe', () => {
  describe('publish → POST /cruxes (first publish)', () => {
    it('accepts a workspace crux with empty data', async () => {
      const out = (await pipe.transform(
        { id: '550e8400-e29b-41d4-a716-446655440000', ...cruxUpsertFields },
        body(CreateCruxDto),
      )) as CreateCruxDto;
      expect(out.data).toBe('');
    });

    it('keeps the client-supplied id — the published subdomain depends on it', async () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const out = (await pipe.transform(
        { id, ...cruxUpsertFields },
        body(CreateCruxDto),
      )) as CreateCruxDto;
      expect(out.id).toBe(id);
    });

    it('passes meta through untouched — whitelist must not recurse into it', async () => {
      const out = (await pipe.transform(
        { id: '550e8400-e29b-41d4-a716-446655440000', ...cruxUpsertFields },
        body(CreateCruxDto),
      )) as CreateCruxDto;
      expect(out.meta).toEqual(cruxUpsertFields.meta);
    });
  });

  describe('publish → PATCH /cruxes/:id (republish)', () => {
    it('accepts the same upsert fields', async () => {
      const out = (await pipe.transform(
        cruxUpsertFields,
        body(UpdateCruxDto),
      )) as UpdateCruxDto;
      expect(out.slug).toBe(cruxUpsertFields.slug);
      expect(out.meta).toEqual(cruxUpsertFields.meta);
    });

    it('accepts a null kind (crux with no declared kind)', async () => {
      const out = (await pipe.transform(
        { ...cruxUpsertFields, kind: null },
        body(UpdateCruxDto),
      )) as UpdateCruxDto;
      expect(out.kind).toBeNull();
    });
  });

  describe('connect account → PATCH /authors/:id', () => {
    it('accepts the profile sync payload, including an empty bio', async () => {
      const out = (await pipe.transform(
        { username: 'daniel', displayName: 'Daniel', bio: '' },
        body(UpdateAuthorDto),
      )) as UpdateAuthorDto;
      expect(out.username).toBe('daniel');
    });

    it('accepts a not-yet-filled profile (null display name and bio)', async () => {
      const out = (await pipe.transform(
        { username: 'daniel', displayName: null, bio: null },
        body(UpdateAuthorDto),
      )) as UpdateAuthorDto;
      expect(out.username).toBe('daniel');
    });
  });

  describe('publish → PUT /cruxes/:id/tags', () => {
    it('accepts kebab-case labels', async () => {
      const out = (await pipe.transform(
        { labels: ['astro', 'personal-site'] },
        body(SyncTagsDto),
      )) as SyncTagsDto;
      expect(out.labels).toHaveLength(2);
    });

    it('accepts an empty list (how a non-discoverable crux clears its tags)', async () => {
      const out = (await pipe.transform(
        { labels: [] },
        body(SyncTagsDto),
      )) as SyncTagsDto;
      expect(out.labels).toEqual([]);
    });

    it('rejects labels the tag input must normalize first', async () => {
      await expect(
        pipe.transform({ labels: ['My Site'] }, body(SyncTagsDto)),
      ).rejects.toThrow();
    });
  });
});
