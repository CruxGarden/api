import { z } from 'zod';

export const EDIT_HISTORY_LIMIT = 20;
export interface EditWorkspaceContext {
  parentId: string | null;
  messages: unknown[];
  entryFile: string | null;
}
export const editWorkspaceSchema = z
  .object({
    parentId: z.string().uuid().nullable(),
    messages: z.array(z.unknown()),
    entryFile: z.string().nullable(),
  })
  .strict();
export const retainedWorkspaceSchema = z
  .object({
    root: z.string().regex(/^[a-f0-9]{64}$/),
    workspace: editWorkspaceSchema,
  })
  .strict();
export const editCheckpointSchema = z
  .object({
    id: z.string().uuid(),
    root: z.string().regex(/^[a-f0-9]{64}$/),
    created: z.string().datetime(),
    reason: z.enum(['autosave', 'safety']),
    workspace: editWorkspaceSchema.optional(),
  })
  .strict()
  .refine(
    (row) => !row.workspace || row.reason === 'safety',
    'Only safety copies retain workspace context',
  );
export const editHistorySchema = z
  .object({
    cruxId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    checkpoints: z.array(editCheckpointSchema),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      new Set(row.checkpoints.map((item) => item.id)).size !==
      row.checkpoints.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Duplicate edit checkpoint identity',
      });
    if (
      row.checkpoints.filter((item) => item.reason === 'autosave').length >
      EDIT_HISTORY_LIMIT
    )
      context.addIssue({
        code: 'custom',
        message: 'Edit history exceeds retention',
      });
  });
export interface EditCheckpoint {
  id: string;
  root: string;
  created: string;
  reason: 'autosave' | 'safety';
  workspace?: EditWorkspaceContext;
}
export interface EditHistory {
  cruxId: string;
  revision: number;
  checkpoints: EditCheckpoint[];
}
export function parseEditHistory(value: unknown): EditHistory {
  return editHistorySchema.parse(value) as EditHistory;
}
export const EDIT_HISTORY_SCHEMA = `CREATE TABLE edit_history (
  crux_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  checkpoints TEXT NOT NULL
)`;
