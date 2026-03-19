export default interface PathRaw {
  id: string;
  slug: string;
  title?: string;
  description?: string;
  type: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
  kind: 'guide' | 'wander';
  entry: string;
  author_id: string;
  home_id: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
