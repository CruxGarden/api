export default interface DimensionRaw {
  id: string;
  key: string;
  source_id: string;
  target_id: string;
  type: 'gate' | 'garden' | 'growth' | 'graft';
  weight?: number;
  author_id?: string;
  note?: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
