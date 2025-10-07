export default interface TagRaw {
  id: string;
  key: string;
  resource_type: string;
  resource_id: string;
  label: string;
  author_id: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
  system: boolean;
}
