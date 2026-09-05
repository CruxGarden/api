import type { StoreMode } from './crux-store.entity';

export default interface StoreRaw {
  id: string;
  crux_id: string;
  author_id: string;
  visitor_id: string | null;
  key: string;
  value: any;
  mode: StoreMode;
  created_at: Date;
  updated_at: Date;
}
