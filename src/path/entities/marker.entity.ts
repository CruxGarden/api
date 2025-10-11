export default class Marker {
  id: string;
  key: string;
  pathId: string;
  cruxId: string;
  order: number;
  note?: string;
  authorId: string;
  homeId: string;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Marker>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
