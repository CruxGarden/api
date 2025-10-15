export enum AccountRole {
  ADMIN = 'admin',
  AUTHOR = 'author',
  KEEPER = 'keeper',
}

export enum CruxStatus {
  LIVING = 'living',
  FROZEN = 'frozen',
}

export enum CruxType {
  MARKDOWN = 'markdown',
}

export enum CruxVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  UNLISTED = 'unlisted',
}

export enum DimensionType {
  GATE = 'gate',
  GARDEN = 'garden',
  GROWTH = 'growth',
  GRAFT = 'graft',
}

export enum HealthStatusType {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
}

export enum PathKind {
  GUIDE = 'guide',
  WANDER = 'wander',
}

export enum PathPrefix {
  CRUX = '+',
  PATH_GUIDE = '-',
  PATH_WANDER = '~',
  USERNAME = '@',
}

export enum PathType {
  LIVING = 'living',
  FROZEN = 'frozen',
}

export enum PathVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  UNLISTED = 'unlisted',
}

export enum AuthorEmbed {
  ROOT = 'root',
}

export enum DimensionEmbed {
  NONE = 'none',
  SOURCE = 'source',
  TARGET = 'target',
}

export enum ResourceType {
  AUTHOR = 'author',
  CRUX = 'crux',
  DIMENSION = 'dimension',
  PATH = 'path',
  TAG = 'tag',
  THEME = 'theme',
}

export enum ServiceHealthType {
  UP = 'up',
  DOWN = 'down',
}
