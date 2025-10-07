export default interface MarkerRaw {
  id: string;
  key: string;
  path_id: string;
  crux_id: string;
  order: number;
  note?: string;
  author_id: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
