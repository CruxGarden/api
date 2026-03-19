export default class Crux {
  id: string;
  slug: string;
  title?: string;
  description?: string;
  data: string;
  type: string;
  kind?: string;
  status: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
  discoverable?: boolean;
  authorId: string;
  homeId: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Crux>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
