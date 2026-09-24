import { gardenMoodMode, type GardenMoodMode } from './garden-mood-policy';
export type { GardenMoodMode } from './garden-mood-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CruxGraphService } from '../crux/crux-graph.service';
import { DimensionService } from '../dimension/dimension.service';
import { CruxKind, DimensionType } from '../common/types/enums';
import { GardenMembershipRepository } from './garden-membership.repository';
import {
  GardenMoodRepository,
  MOOD_ASSOCIATION,
} from './garden-mood.repository';

export interface GardenMoodSelection {
  mode: GardenMoodMode;
  edgeId: string | null;
  moodId: string | null;
}
export interface SelectGardenMood {
  gardenId: string;
  mode: GardenMoodMode;
  moodId: string | null;
  expected: GardenMoodSelection;
  /** Trusted host attribution; remote transports must authorize it. */
  authorId: string;
  homeId: string;
}

/** LocalGraphRuntime wraps every command in one complete transaction. */
@Injectable()
export class GardenMoodService {
  constructor(
    private readonly graph: CruxGraphService,
    private readonly dimensions: DimensionService,
    private readonly links: GardenMoodRepository,
    private readonly memberships: GardenMembershipRepository,
  ) {}
  private id(value: string) {
    if (typeof value !== 'string' || !isUUID(value))
      throw new BadRequestException('Use a valid Crux identity');
  }
  private mode(value: unknown): GardenMoodMode {
    if (value !== 'inherit' && value !== 'own' && value !== 'none')
      throw new BadRequestException('This Garden’s Mood policy is unsupported');
    return value;
  }
  private async mood(id: string) {
    this.id(id);
    const mood = await this.graph.findById(id);
    if (mood.kind !== CruxKind.MOOD || mood.deleted)
      throw new BadRequestException('Choose an available Mood Crux');
    return mood;
  }
  async read(gardenId: string) {
    this.id(gardenId);
    const garden = await this.graph.findById(gardenId);
    if (garden.kind !== CruxKind.GARDEN || garden.deleted)
      throw new BadRequestException('This Garden is unavailable');
    const mode = gardenMoodMode(garden.meta?.moodSelection);
    const rows = await this.links.list(gardenId);
    if (rows.error)
      throw new InternalServerErrorException(
        'Could not inspect the Garden’s Mood',
      );
    if (
      (mode === 'own' && rows.data.length !== 1) ||
      (mode !== 'own' && rows.data.length !== 0)
    )
      throw new ConflictException(
        'This Garden’s Mood association is inconsistent',
      );
    const edge = rows.data[0];
    const selection: GardenMoodSelection = {
      mode,
      edgeId: edge?.id ?? null,
      moodId: edge?.target_id ?? null,
    };
    // Inspection retains even an unavailable target so it can be explicitly reset.
    return { gardenId, title: garden.title, selection };
  }
  async resolve(gardenId: string) {
    let id = gardenId;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(id))
        throw new ConflictException('Garden Mood inheritance contains a cycle');
      if (seen.size >= 256)
        throw new ConflictException('Garden Mood inheritance is too deep');
      seen.add(id);
      const current = await this.read(id);
      if (current.selection.mode !== 'inherit') {
        if (current.selection.moodId) await this.mood(current.selection.moodId);
        return {
          gardenId,
          mode: current.selection.mode,
          moodId: current.selection.moodId,
          sourceGardenId: id,
          sourceTitle: current.title,
        };
      }
      const parents = await this.memberships.parents(id);
      if (parents.error)
        throw new InternalServerErrorException(
          'Could not resolve this Garden’s Mood',
        );
      const ids = [...new Set(parents.data.map((edge) => edge.source_id))];
      if (!ids.length)
        return {
          gardenId,
          mode: 'default' as const,
          moodId: null,
          sourceGardenId: null,
          sourceTitle: null,
        };
      if (ids.length !== 1)
        throw new ConflictException(
          'This Garden has multiple containers. Choose its own Mood to resolve inheritance.',
        );
      id = ids[0];
    }
  }
  async select(input: SelectGardenMood) {
    if (!input || typeof input !== 'object')
      throw new BadRequestException(
        'Inspect a Garden before choosing its Mood',
      );
    for (const id of [input.gardenId, input.authorId, input.homeId])
      this.id(id);
    const mode = this.mode(input.mode);
    if (mode === 'own') await this.mood(input.moodId);
    else if (input.moodId !== null)
      throw new BadRequestException('Inherit or none cannot select a Mood');
    const before = await this.read(input.gardenId);
    const expected = input.expected;
    if (
      !expected ||
      before.selection.mode !== expected.mode ||
      before.selection.edgeId !== expected.edgeId ||
      before.selection.moodId !== expected.moodId
    )
      throw new ConflictException(
        'This Garden’s Mood changed. Inspect it and retry.',
      );
    if (
      before.selection.mode === mode &&
      before.selection.moodId === input.moodId
    )
      return before;
    const cleared = await this.links.clear(input.gardenId);
    if (cleared.error)
      throw new InternalServerErrorException(
        'Could not replace the Garden’s Mood',
      );
    const remaining = await this.links.list(input.gardenId);
    if (remaining.error || remaining.data.length)
      throw new ConflictException(
        'The previous Mood association could not be removed',
      );
    let edgeId: string | null = null;
    if (mode === 'own') {
      const edge = await this.dimensions.create({
        sourceId: input.gardenId,
        targetId: input.moodId,
        type: DimensionType.GRAFT,
        kind: MOOD_ASSOCIATION,
        authorId: input.authorId,
        homeId: input.homeId,
      });
      edgeId = edge.id;
    }
    const owner = await this.graph.findById(input.gardenId);
    await this.graph.update(input.gardenId, {
      meta: {
        ...owner.meta,
        moodSelection: { ...owner.meta?.moodSelection, version: 1, mode },
      },
    });
    const after = await this.read(input.gardenId);
    if (
      after.selection.mode !== mode ||
      after.selection.moodId !== input.moodId ||
      after.selection.edgeId !== edgeId
    )
      throw new ConflictException('The Garden’s Mood selection was not saved');
    return after;
  }
}
