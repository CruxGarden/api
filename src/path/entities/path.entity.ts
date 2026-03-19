export default class Path {
  id: string;
  slug: string;
  title?: string;
  description?: string;
  type: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
  kind: 'guide' | 'wander';
  entry: string;
  authorId: string;
  homeId: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Path>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
