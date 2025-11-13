export default interface ThemeRaw {
  id: string;
  author_id: string;
  home_id: string;
  title: string;
  key: string;
  description?: string;
  type?: string;
  kind?: string;
  system: boolean; // True for system-provided themes
  meta?: any; // JSONB field containing all styling data
  created: Date;
  updated: Date;
  deleted: Date | null;
}
