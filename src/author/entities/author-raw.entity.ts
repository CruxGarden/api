export default interface AuthorRaw {
  id: string;
  key: string;
  account_id: string;
  username: string;
  display_name: string;
  bio?: string;
  home_id?: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
