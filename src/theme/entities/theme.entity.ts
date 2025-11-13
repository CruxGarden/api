export default class Theme {
  id: string;
  authorId: string;
  homeId: string;
  title: string;
  key: string;
  description?: string;
  type?: string;
  kind?: string;
  system: boolean; // True for system-provided themes
  meta?: any; // JSONB field containing all styling data
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Theme>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, system, ...rest } = this;
    return rest;
  }
}
