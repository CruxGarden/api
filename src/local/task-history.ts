import { z } from 'zod';

/** Durable retention owner, never an arbitrary manifest root supplied by the UI. */
export const taskHistorySelectionSchema = z
  .object({
    cruxId: z.string().uuid(),
    id: z.string().uuid(),
    part: z.enum(['base', 'source', 'target', 'result']),
  })
  .strict();
export interface TaskHistorySelection {
  cruxId: string;
  id: string;
  part: 'base' | 'source' | 'target' | 'result';
}
