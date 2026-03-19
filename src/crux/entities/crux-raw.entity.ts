export default interface CruxRaw {
  id: string;
  slug: string;
  title?: string;
  description?: string;
  data: string;
  type: string;
  kind?: string;
  status: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
  discoverable?: boolean;
  author_id: string;
  home_id: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
