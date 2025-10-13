export default class Crux {
  id: string;
  key: string;
  slug: string;
  title?: string;
  description?: string;
  data: string;
  type: string;
  kind?: string;
  themeId?: string;
  status: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
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
