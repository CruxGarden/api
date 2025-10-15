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
  // Joined from cruxes table (target)
  target_key?: string;
  target_slug?: string;
  target_title?: string;
  target_data?: string;
  // Joined from cruxes table (source)
  source_key?: string;
  source_slug?: string;
  source_title?: string;
  source_data?: string;
}
