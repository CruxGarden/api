export default interface PathRaw {
  id: string;
  key: string;
  slug: string;
  title?: string;
  description?: string;
  type: 'living' | 'frozen';
  visibility: 'public' | 'private' | 'unlisted';
  kind: 'guide' | 'wander';
  entry: string;
  author_id: string;
  theme_id?: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
