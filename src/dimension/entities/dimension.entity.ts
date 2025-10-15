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
  // Joined from cruxes table (target)
  targetKey?: string;
  targetSlug?: string;
  targetTitle?: string;
  targetData?: string;
  // Joined from cruxes table (source)
  sourceKey?: string;
  sourceSlug?: string;
  sourceTitle?: string;
  sourceData?: string;

  constructor(partial: Partial<Dimension>) {
    Object.assign(this, partial);
  }

  toJSON() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      deleted,
      sourceKey,
      sourceSlug,
      sourceTitle,
      sourceData,
      targetKey,
      targetSlug,
      targetTitle,
      targetData,
      ...rest
    } = this;

    const result: any = { ...rest };

    // If source fields are present, nest under source object (additive)
    if (sourceKey || sourceSlug || sourceTitle || sourceData) {
      result.source = {
        id: this.sourceId,
        key: sourceKey,
        slug: sourceSlug,
        title: sourceTitle,
        data: sourceData,
      };
    }

    // If target fields are present, nest under target object (additive)
    if (targetKey || targetSlug || targetTitle || targetData) {
      result.target = {
        id: this.targetId,
        key: targetKey,
        slug: targetSlug,
        title: targetTitle,
        data: targetData,
      };
    }

    return result;
  }
}
