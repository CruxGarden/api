export default class Report {
  id: string;
  cruxId: string;
  authorId?: string;
  cruxSlug?: string;
  cruxTitle?: string;
  reason: string;
  details?: string;
  reporterEmail?: string;
  reporterIpHash?: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolutionNote?: string;
  resolvedBy?: string;
  resolved?: Date;
  created: Date;
  updated: Date;
  deleted?: Date;

  constructor(partial: Partial<Report>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { deleted, ...rest } = this;
    return rest;
  }
}
