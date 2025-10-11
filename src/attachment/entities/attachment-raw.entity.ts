export default interface AttachmentRaw {
  id: string;
  key: string;
  type: string;
  kind: string;
  meta: any;
  resource_id: string;
  resource_type: string;
  author_id: string;
  home_id: string;
  encoding: string;
  mime_type: string;
  filename: string;
  size: number;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
