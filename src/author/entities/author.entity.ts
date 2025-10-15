export default class Author {
  id: string;
  key: string;
  username: string;
  displayName: string;
  bio?: string;
  rootId?: string;
  accountId: string;
  homeId: string;
  type?: string;
  kind?: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted?: Date;
  root?: any; // Embedded root crux (populated via embed query param)

  constructor(partial: Partial<Author>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, rootId, root, ...rest } = this;

    if (root) {
      return { ...rest, root };
    } else {
      return { ...rest, rootId };
    }
  }
}
