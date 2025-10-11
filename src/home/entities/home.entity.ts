export default class Home {
  id: string;
  key: string;
  name: string;
  description?: string;
  primary: boolean;
  type: string;
  kind: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Home>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
