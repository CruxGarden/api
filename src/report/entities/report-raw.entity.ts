export default interface ReportRaw {
  id: string;
  crux_id: string;
  author_id?: string | null;
  crux_slug?: string | null;
  crux_title?: string | null;
  reason: string;
  details?: string | null;
  reporter_email?: string | null;
  reporter_ip_hash?: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  resolution_note?: string | null;
  resolved_by?: string | null;
  resolved?: Date | null;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
