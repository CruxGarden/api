export default interface AccountRaw {
  id: string;
  email: string;
  role: 'admin' | 'author' | 'keeper';
  home_id: string;
  created: Date;
  updated: Date;
  deleted: Date | null;
  /** operator hold (ADR 0083): sign-in works, hosted writes are refused */
  suspended?: Date | null;
  suspended_reason?: string | null;
  suspended_by?: string | null;
}
