export default class Author {
  id: string;
  key: string;
  username: string;
  displayName: string;
  bio?: string;
  accountId: string;
  homeId?: string;
  home?: any; // Populated when embed=home, replaces homeId
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Author>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, homeId, home, ...rest } = this;

    if (home) {
      return { ...rest, home };
    } else {
      return { ...rest, homeId };
    }
  }
}
