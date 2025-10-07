export default class Account {
  id: string;
  email: string;
  role: 'admin' | 'author' | 'keeper';
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Account>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
