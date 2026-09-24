export {
  prepareDesktopContent,
  inspectDesktopContent,
} from './desktop-content';
export type { DesktopContentStore } from './desktop-content';
export {
  inspectDesktopRecovery,
  inspectDesktopManifestRecovery,
} from './desktop-recovery';
export type { DesktopRecoveryInspection } from './desktop-recovery';
export { LocalGraphRuntime } from './graph-runtime';
export type { GraphOperations, LocalGraphChange } from './graph-runtime';
export type {
  AddGardenMember,
  MoveGardenMember,
} from './garden-membership.service';
export type {
  GraphSelection,
  SelectedGraphCapture,
} from './selected-graph.service';
export {
  CruxKind,
  CruxType,
  CruxStatus,
  CruxVisibility,
  DimensionType,
} from '../common/types/enums';
export type { CreateCruxDto } from '../crux/dto/create-crux.dto';
export type { UpdateCruxDto } from '../crux/dto/update-crux.dto';
export type { CreateDimensionDto } from '../dimension/dto/create-dimension.dto';
export type { UpdateDimensionDto } from '../dimension/dto/update-dimension.dto';

export type { LocalCruxUpdate } from './crux-update';

export type { LocalCruxCreate, PrepareCruxFolder } from './crux-create';

export type {
  LocalWorkingCopyCreate,
  PrepareWorkingCopyFolder,
} from './working-copy-create';

// Host-side file-content primitives; no renderer transport or normal-profile adoption.
export { FileManifest } from './file-manifest';
export type { FileEntry, FileEdit } from './file-manifest';
export type {
  FileContentCommit,
  FileContentEdit,
  FileContentChange,
  FileContentRead,
  FileContentSelection,
  FileContentListResult,
  FileContentReadResult,
} from './file-content.service';
export type { FileContentHead } from './file-content.repository';

export type {
  GrowthSnapshotCreate,
  GrowthContentRestore,
} from './growth-content.service';

export type {
  PrivateGraph,
  PrivateGraphImport,
  PrivateGraphImportResult,
} from './portable-graph';

export {
  packPrivateGraph,
  openPrivateGraphArchive,
} from './private-graph-archive';

export type { PrepareImportedWorkspace } from './import-workspace';

export type { GardenEntry } from './garden-entry.service';

export type { EditCheckpoint, EditHistory } from './edit-history';
export type { EditCheckpointRestore } from './edit-history.service';
