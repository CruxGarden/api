export default interface CruxRaw {
  id: string;
  key: string;
  slug: string;
  title?: string;
  description?: string;
  data: string;
  type: string;
  theme_id?: string;
  status: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
  author_id: string;
  home_id: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
