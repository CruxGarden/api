export default interface AuthorRaw {
  id: string;
  key: string;
  account_id: string;
  username: string;
  display_name: string;
  bio?: string;
  root_id?: string;
  home_id?: string;
  type?: string;
  kind?: string;
  meta?: any;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
