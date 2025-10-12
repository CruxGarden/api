import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { UpdateTagDto } from './dto/update-tag.dto';
import { TagRepository } from './tag.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { HomeService } from '../home/home.service';
import TagRaw from './entities/tag-raw.entity';
import Tag from './entities/tag.entity';
import { ResourceType } from '../common/types/enums';

@Injectable()
export class TagService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly tagRepository: TagRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly homeService: HomeService,
  ) {
    this.logger = this.loggerService.createChildLogger('TagService');
  }

  asTag(data: TagRaw): Tag {
    const entityFields = toEntityFields(data);
    return new Tag(entityFields);
  }

  asTags(rows: TagRaw[]): Tag[] {
    return rows.map((row) => this.asTag(row));
  }

  findAllQuery(
    resourceType?: ResourceType,
    search?: string,
    sort: 'alpha' | 'count' = 'count',
    label?: string,
  ): Knex.QueryBuilder<TagRaw, TagRaw[]> {
    return this.tagRepository.findAllQuery(resourceType, search, sort, label);
  }

  async findBy(fieldName: string, fieldValue: any): Promise<Tag> {
    const { data: tag, error } = await this.tagRepository.findBy(
      fieldName,
      fieldValue,
    );
    if (error || !tag) throw new NotFoundException('Tag not found');

    return this.asTag(tag);
  }

  async findById(id: string): Promise<Tag> {
    return this.findBy('id', id);
  }

  async findByKey(key: string): Promise<Tag> {
    return this.findBy('key', key);
  }

  async update(tagKey: string, updateDto: UpdateTagDto): Promise<Tag> {
    const tagToUpdate = await this.findByKey(tagKey);
    const updated = await this.tagRepository.update(tagToUpdate.id, updateDto);
    if (updated.error)
      throw new InternalServerErrorException(
        `Tag update error: ${updated.error}`,
      );

    return this.asTag(updated.data);
  }

  async delete(tagKey: string): Promise<null> {
    const tagToDelete = await this.findByKey(tagKey);
    const deleted = await this.tagRepository.delete(tagToDelete.id);
    if (deleted.error) {
      throw new InternalServerErrorException(
        `Tag deletion error: ${deleted.error}`,
      );
    }

    return null;
  }

  async getTags(
    resourceType: ResourceType,
    resourceId: string,
    filter?: string,
  ): Promise<Tag[]> {
    const { data, error } = await this.tagRepository.findByResource(
      resourceType,
      resourceId,
    );

    if (error) {
      throw new InternalServerErrorException(`Error fetching tags: ${error}`);
    }

    let tags = data || [];

    if (filter) {
      tags = tags.filter((tag) => tag.label.includes(filter.toLowerCase()));
    }

    return this.asTags(tags);
  }

  async syncTags(
    resourceType: ResourceType,
    resourceId: string,
    labels: string[],
    authorId: string,
  ): Promise<Tag[]> {
    const home = await this.homeService.primary();

    // Normalize labels to lowercase
    const normalizedLabels = labels.map((label) => label.toLowerCase());

    // Get existing tags for this resource
    const { data: existingTags, error: fetchError } =
      await this.tagRepository.findByResource(resourceType, resourceId);

    if (fetchError) {
      throw new InternalServerErrorException(
        `Error fetching existing tags: ${fetchError}`,
      );
    }

    const existingLabels = (existingTags || []).map((tag) => tag.label);

    // Find labels to add (in new list but not in existing)
    const labelsToAdd = normalizedLabels.filter(
      (label) => !existingLabels.includes(label),
    );

    // Find tags to remove (in existing but not in new list)
    const tagsToRemove = (existingTags || []).filter(
      (tag) => !normalizedLabels.includes(tag.label),
    );

    // Delete tags that are no longer needed
    for (const tag of tagsToRemove) {
      const deleteResult = await this.tagRepository.delete(tag.id);
      if (deleteResult.error) {
        throw new InternalServerErrorException(
          `Error deleting tag: ${deleteResult.error}`,
        );
      }
    }

    // Create new tags
    if (labelsToAdd.length > 0) {
      const tagsToCreate: Partial<Tag>[] = labelsToAdd.map((label) => ({
        id: this.keyMaster.generateId(),
        key: this.keyMaster.generateKey(),
        resourceType: resourceType,
        resourceId: resourceId,
        label: label,
        authorId: authorId,
        homeId: home.id,
        system: false,
        created: new Date(),
        updated: new Date(),
      }));

      const createResult = await this.tagRepository.createMany(tagsToCreate);

      if (createResult.error) {
        throw new InternalServerErrorException(
          `Error creating tags: ${createResult.error}`,
        );
      }
    }

    // Return all current tags for this resource
    const { data: finalTags, error: finalError } =
      await this.tagRepository.findByResource(resourceType, resourceId);

    if (finalError) {
      throw new InternalServerErrorException(
        `Error fetching final tags: ${finalError}`,
      );
    }

    return this.asTags(finalTags || []);
  }
}
