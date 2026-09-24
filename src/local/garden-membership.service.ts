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
import {
  GardenMembershipRepository,
  GARDEN_MEMBERSHIP,
} from './garden-membership.repository';

export interface AddGardenMember {
  gardenId: string;
  memberId: string;
  /** Captured trusted host identity; a future transport must stamp/authorize it. */
  authorId: string;
  homeId: string;
}
export interface MoveGardenMember extends AddGardenMember {
  expectedParents: string[];
}

/** V1 application policy only; the graph schema itself remains unrestricted.
 * A Garden placement is the child's incoming Gate in navigation projections. */
export function assertSinglePlacement(
  placements: ReadonlyArray<{ sourceId: string; targetId: string }>,
) {
  const parents = new Map<string, string>();
  for (const edge of placements) {
    const previous = parents.get(edge.targetId);
    if (previous !== undefined && previous !== edge.sourceId)
      throw new ConflictException(
        'This Crux is already planted in another Garden. Move it instead.',
      );
    parents.set(edge.targetId, edge.sourceId);
  }
}

/** Called only inside LocalGraphRuntime's complete-command transaction. */
@Injectable()
export class GardenMembershipService {
  constructor(
    private readonly graph: CruxGraphService,
    private readonly dimensions: DimensionService,
    private readonly memberships: GardenMembershipRepository,
  ) {}

  private id(value: string) {
    if (typeof value !== 'string' || !isUUID(value))
      throw new BadRequestException('Use a valid Crux identity');
  }

  private async garden(id: string) {
    this.id(id);
    const garden = await this.graph.findById(id);
    if (garden.kind !== CruxKind.GARDEN)
      throw new BadRequestException('Membership must belong to a Garden');
    return garden;
  }

  async add(input: AddGardenMember) {
    input = { ...input };
    await this.garden(input.gardenId);
    for (const id of [input.memberId, input.authorId, input.homeId])
      this.id(id);
    if (input.gardenId === input.memberId)
      throw new ConflictException('A Garden cannot contain itself');
    const root = await this.memberships.isRoot(input.memberId);
    if (root.error)
      throw new InternalServerErrorException('Could not check Garden root');
    if (root.data)
      throw new ConflictException('The home root cannot have a parent');
    const member = await this.graph.findById(input.memberId);
    if ((member.kind as string) === 'snapshot')
      throw new BadRequestException(
        'Snapshots belong to Growth, not Garden membership',
      );
    const existing = await this.memberships.find(
      input.gardenId,
      input.memberId,
    );
    if (existing.error)
      throw new InternalServerErrorException(
        'Could not check Garden membership',
      );
    if (existing.data) return this.dimensions.asDimension(existing.data);
    const parents = await this.memberships.parents(input.memberId);
    if (parents.error)
      throw new InternalServerErrorException(
        'Could not check this Crux’s location',
      );
    assertSinglePlacement([
      ...parents.data.map((edge) => ({
        sourceId: edge.source_id,
        targetId: edge.target_id,
      })),
      { sourceId: input.gardenId, targetId: input.memberId },
    ]);
    const path = await this.memberships.reaches(input.memberId, input.gardenId);
    if (path.error)
      throw new InternalServerErrorException(
        'Could not check Garden containment',
      );
    if (path.data.reachable)
      throw new ConflictException(
        'Garden membership would create a containment cycle',
      );
    return this.dimensions.create({
      sourceId: input.gardenId,
      targetId: input.memberId,
      type: DimensionType.GARDEN,
      kind: GARDEN_MEMBERSHIP,
      authorId: input.authorId,
      homeId: input.homeId,
    });
  }

  async remove(gardenId: string, memberId: string) {
    await this.garden(gardenId);
    this.id(memberId);
    // Missing/trashed targets can still be unlinked. Never delete the target.
    const result = await this.memberships.remove(gardenId, memberId);
    if (result.error)
      throw new InternalServerErrorException(
        'Could not remove Garden membership',
      );
    return result.data;
  }

  async parents(memberId: string) {
    this.id(memberId);
    await this.graph.findById(memberId);
    const result = await this.memberships.parentIdentities(memberId);
    if (result.error)
      throw new InternalServerErrorException(
        'Could not read this Crux’s location',
      );
    return result.data;
  }

  /** All removals and replacement admission share the caller's transaction. */
  async move(input: MoveGardenMember) {
    if (!Array.isArray(input.expectedParents))
      throw new BadRequestException(
        'Inspect this Crux’s location before moving it',
      );
    input = { ...input, expectedParents: [...input.expectedParents] };
    this.id(input.memberId);
    input.expectedParents.forEach((id) => this.id(id));
    await this.garden(input.gardenId);
    const parents = await this.memberships.parents(input.memberId);
    if (parents.error)
      throw new InternalServerErrorException(
        'Could not check this Crux’s location',
      );
    const current = [
      ...new Set(parents.data.map((row) => row.source_id)),
    ].sort();
    if (
      JSON.stringify(current) !==
      JSON.stringify([...new Set(input.expectedParents)].sort())
    )
      throw new ConflictException(
        'This Crux’s location changed. Inspect it and retry.',
      );
    if (current.length === 1 && current[0] === input.gardenId)
      return this.add(input);
    for (const parent of current) {
      const removed = await this.memberships.remove(parent, input.memberId);
      if (removed.error)
        throw new InternalServerErrorException('Could not move this Crux');
    }
    const remaining = await this.memberships.parents(input.memberId);
    if (remaining.error || remaining.data.length)
      throw new ConflictException(
        'This Crux’s previous location could not be removed',
      );
    return this.add(input);
  }

  async list(
    gardenId: string,
    options: { limit?: number; after?: string } = {},
  ) {
    await this.garden(gardenId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Use a page size from 1 to 100');
    if (options.after !== undefined) this.id(options.after);
    const result = await this.memberships.list(gardenId, limit, options.after);
    if (result.error)
      throw new InternalServerErrorException('Could not list Garden members');
    const items = result.data.slice(0, limit);
    return {
      items,
      next: result.data.length > limit ? items[items.length - 1].id : null,
    };
  }
}
