export default interface TakedownRaw {
  id: string;
  crux_id: string;
  author_id?: string | null;
  reason: string;
  report_id?: string | null;
  created_by: string;
  lifted?: Date | null;
  lifted_by?: string | null;
  created: Date;
  updated: Date;
  deleted: Date | null;
}
