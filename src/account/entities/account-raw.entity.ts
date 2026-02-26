export default interface AccountRaw {
  id: string;
  email: string;
  role: 'admin' | 'author' | 'keeper';
  home_id: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
