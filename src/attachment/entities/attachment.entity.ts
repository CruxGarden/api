export default class Attachment {
  id: string;
  key: string;
  type: string;
  kind: string;
  meta?: any;
  resourceId: string;
  resourceType: string;
  authorId: string;
  homeId: string;
  encoding: string;
  mimeType: string;
  filename: string;
  size: number;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Attachment>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
