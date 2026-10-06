export default class Takedown {
  id: string;
  cruxId: string;
  authorId?: string;
  reason: string;
  reportId?: string;
  createdBy: string;
  lifted?: Date;
  liftedBy?: string;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Takedown>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
