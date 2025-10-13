export default class Dimension {
  id: string;
  key: string;
  sourceId: string;
  targetId: string;
  type: 'gate' | 'garden' | 'growth' | 'graft';
  kind?: string;
  weight?: number;
  authorId?: string;
  homeId: string;
  note?: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Dimension>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
