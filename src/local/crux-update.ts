import { CruxKind, CruxStatus, CruxVisibility } from '../common/types/enums';

/** Desktop detail edits. Ownership and relationships use separate commands.
 * snapshot preserves desktop Growth records; remoteId remains a transitional desktop sync reference, not hosted identity. */
export interface LocalCruxUpdate {
  title?: string;
  slug?: string;
  description?: string;
  data?: string;
  type?: string;
  kind?: `${CruxKind}` | 'snapshot' | null;
  status?: `${CruxStatus}`;
  visibility?: `${CruxVisibility}`;
  discoverable?: boolean;
  meta?: Record<string, unknown>;
  remoteId?: string;
}

function validate(patch: LocalCruxUpdate): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('Use a Crux update object');
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'title':
      case 'slug':
      case 'description':
      case 'data':
      case 'type':
      case 'remoteId':
        if (value !== undefined && typeof value !== 'string')
          throw new Error(`Use a string for ${key}`);
        break;
      case 'kind':
        if (
          value !== undefined &&
          value !== null &&
          value !== 'snapshot' &&
          !Object.values(CruxKind).includes(value)
        )
          throw new Error('Use a supported Crux kind');
        break;
      case 'status':
        if (value !== undefined && !Object.values(CruxStatus).includes(value))
          throw new Error('Use a supported Crux status');
        break;
      case 'visibility':
        if (
          value !== undefined &&
          !Object.values(CruxVisibility).includes(value)
        )
          throw new Error('Use a supported Crux visibility');
        break;
      case 'discoverable':
        if (value !== undefined && typeof value !== 'boolean')
          throw new Error('Use a boolean for discoverable');
        break;
      case 'meta':
        if (
          value !== undefined &&
          (!value || typeof value !== 'object' || Array.isArray(value))
        )
          throw new Error('Use a metadata object');
        break;
      default:
        throw new Error(`Unsupported Crux update field: ${key}`);
    }
  }
}

export function captureCruxUpdate(patch: LocalCruxUpdate): LocalCruxUpdate {
  validate(patch);
  const captured = JSON.parse(JSON.stringify(patch));
  validate(captured);
  return captured;
}
