export default interface StoreRaw {
  id: string;
  crux_id: string;
  author_id: string;
  visitor_id: string | null;
  key: string;
  value: any;
  mode: string;
  created_at: Date;
  updated_at: Date;
}
