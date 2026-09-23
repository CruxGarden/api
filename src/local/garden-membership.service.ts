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
