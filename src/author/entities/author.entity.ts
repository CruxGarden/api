export default class Author {
  id: string;
  key: string;
  username: string;
  displayName: string;
  bio?: string;
  accountId: string;
  homeId: string;
  type?: string;
  kind?: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Author>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
