export default interface DimensionRaw {
  id: string;
  key: string;
  source_id: string;
  target_id: string;
  type: 'gate' | 'garden' | 'growth' | 'graft';
  kind?: string;
  weight?: number;
  author_id?: string;
  home_id: string;
  note?: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
