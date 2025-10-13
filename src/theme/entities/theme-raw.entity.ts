export default interface ThemeRaw {
  id: string;
  author_id: string;
  home_id: string;
  title: string;
  key: string;
  description?: string;
  type?: string;
  kind?: string;
  primary_color: string;
  secondary_color: string;
  tertiary_color: string;
  quaternary_color: string;
  border_radius?: string;
  background_color?: string;
  panel_color?: string;
  text_color?: string;
  font?: string;
  mode?: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
