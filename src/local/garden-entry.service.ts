import { randomUUID } from 'crypto';
import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CruxKind } from '../common/types/enums';
import { RepositoryResponse } from '../common/types/interfaces';
import { CruxGraphService } from '../crux/crux-graph.service';
import { CruxLifecycleService } from './crux-lifecycle.service';
import {
  GardenEntryRepository,
  LOCAL_GARDEN_ID,
  LOCAL_AUTHOR_ID,
  LOCAL_HOME_ID,
} from './garden-entry.repository';

export interface GardenEntry {
  id: string;
  title: string;
  slug: string;
  kind: CruxKind.GARDEN;
}

/** Entire entry command runs in the API owner's transaction. */
@Injectable()
export class GardenEntryService {
  constructor(
    private readonly entries: GardenEntryRepository,
    private readonly graph: CruxGraphService,
    private readonly lifecycle: CruxLifecycleService,
  ) {}

  private unwrap<T>(result: RepositoryResponse<T>): T {
    if (result.error)
      throw new InternalServerErrorException(result.error.message);
    return result.data!;
  }

  private async entry(id: string): Promise<GardenEntry> {
    if (!isUUID(id))
      throw new ConflictException('The local Garden entry is invalid');
    const crux = await this.graph.findById(id);
    if (crux.kind !== CruxKind.GARDEN)
      throw new ConflictException(
        'The local Garden entry must refer to a Garden',
      );
    return {
      id: crux.id,
      title: crux.title,
      slug: crux.slug,
      kind: CruxKind.GARDEN,
    };
  }

  async enter(): Promise<{ entry: GardenEntry; created: boolean }> {
    const settings = this.unwrap(await this.entries.read());
    let authorId = settings[LOCAL_AUTHOR_ID];
    let homeId = settings[LOCAL_HOME_ID];
    const initialized = authorId !== undefined || homeId !== undefined;
    if (initialized && (!isUUID(authorId ?? '') || !isUUID(homeId ?? '')))
      throw new ConflictException(
        'The local Garden identity is incomplete or invalid',
      );
    if (settings[LOCAL_GARDEN_ID] !== undefined) {
      if (!initialized)
        throw new ConflictException('The local Garden identity is missing');
      return {
        entry: await this.entry(settings[LOCAL_GARDEN_ID]),
        created: false,
      };
    }
    if (!initialized) {
      authorId = randomUUID();
      homeId = randomUUID();
      this.unwrap(
        await this.entries.insert({
          [LOCAL_AUTHOR_ID]: authorId,
          [LOCAL_HOME_ID]: homeId,
        }),
      );
    }
    const id = await this.lifecycle.create({
      slug: 'my-garden',
      title: 'My Garden',
      kind: CruxKind.GARDEN,
      authorId,
      homeId,
    });
    this.unwrap(await this.entries.insert({ [LOCAL_GARDEN_ID]: id }));
    return { entry: await this.entry(id), created: true };
  }
}
