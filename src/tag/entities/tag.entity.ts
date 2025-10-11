import { ResourceType } from '../../common/types/enums';

export default class Tag {
  id: string;
  key: string;
  resourceType: ResourceType;
  resourceId: string;
  label: string;
  authorId: string;
  homeId: string;
  created: Date;
  updated: Date;
  deleted?: Date;
  system: boolean;

  constructor(partial: Partial<Tag>) {
    Object.assign(this, partial);
  }

  toJSON() {
    const { deleted, system, ...rest } = this; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  }
}
