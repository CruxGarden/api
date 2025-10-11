export default interface HomeRaw {
  id: string;
  key: string;
  name: string;
  description?: string;
  primary: boolean;
  type: string;
  kind: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
