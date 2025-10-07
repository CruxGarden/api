# Crux Garden API Endpoints

## App Module
- GET `/` - Health check (includes database and Redis status)

## Authentication (auth)
All endpoints are public except where noted.

- POST `/auth/code` - Request authentication code via email
- POST `/auth/login` - Login with email and code
- POST `/auth/token` - Refresh authentication token
- GET `/auth/profile` - Get current account profile (requires auth)
- POST `/auth/logout` - Logout current session (requires auth)

## Account Management (account)
All endpoints require authentication.

- GET `/account` - Get current account details
- PATCH `/account` - Update current account
- DELETE `/account` - Delete current account

## Authors (authors)
All endpoints require authentication.

- GET `/authors` - Get all authors (paginated)
- GET `/authors/:identifier` - Get author by key or username (prefix with @ for username)
- POST `/authors` - Create new author
- PATCH `/authors/:authorKey` - Update author (requires ownership)
- DELETE `/authors/:authorKey` - Delete author (requires ownership)

## Cruxes (cruxes)
All endpoints require authentication.

### Core CRUD
- GET `/cruxes` - Get all cruxes (paginated)
- GET `/cruxes/:cruxKey` - Get crux by key
- POST `/cruxes` - Create new crux
- PATCH `/cruxes/:cruxKey` - Update crux (requires ownership)
- DELETE `/cruxes/:cruxKey` - Delete crux (requires ownership)

### Dimensions (Relationships)
- GET `/cruxes/:cruxKey/dimensions` - Get all dimensions for a crux (optional type filter)
- POST `/cruxes/:cruxKey/dimensions` - Create dimension from this crux (requires ownership)

### Tags
- GET `/cruxes/:cruxKey/tags` - Get all tags for a crux (optional filter)
- PUT `/cruxes/:cruxKey/tags` - Sync tags for a crux (requires ownership)

## Dimensions (dimensions)
All endpoints require authentication.

- GET `/dimensions/:dimensionKey` - Get dimension by key
- PATCH `/dimensions/:dimensionKey` - Update dimension (requires ownership of source crux)
- DELETE `/dimensions/:dimensionKey` - Delete dimension (requires ownership of source crux)

## Paths (paths)
All endpoints require authentication.

### Core CRUD
- GET `/paths` - Get all paths (paginated)
- GET `/paths/:pathKey` - Get path by key
- POST `/paths` - Create new path
- PATCH `/paths/:pathKey` - Update path (requires ownership)
- DELETE `/paths/:pathKey` - Delete path (requires ownership)

### Markers (Crux References)
- GET `/paths/:pathKey/markers` - Get all markers for a path
- PUT `/paths/:pathKey/markers` - Sync markers for a path (requires ownership)

### Tags
- GET `/paths/:pathKey/tags` - Get all tags for a path (optional filter)
- PUT `/paths/:pathKey/tags` - Sync tags for a path (requires ownership)

## Tags (tags)
All endpoints require authentication.

- GET `/tags` - Get all tags (paginated, supports filters: resourceType, search, sort, label)
- GET `/tags/:tagKey` - Get tag by key
- PATCH `/tags/:tagKey` - Update tag (requires admin)
- DELETE `/tags/:tagKey` - Delete tag (requires admin)

## Themes (themes)
All endpoints require authentication.

### Core CRUD
- GET `/themes` - Get all themes (paginated)
- GET `/themes/:themeKey` - Get theme by key
- POST `/themes` - Create new theme
- PATCH `/themes/:themeKey` - Update theme (requires ownership)
- DELETE `/themes/:themeKey` - Delete theme (requires ownership)

### Tags
- GET `/themes/:themeKey/tags` - Get all tags for a theme (optional filter)
- PUT `/themes/:themeKey/tags` - Sync tags for a theme (requires ownership)

## Notes

### Authentication Pattern
- Public endpoints: auth code, login, token
- Protected endpoints: all others require bearer token

### Ownership Pattern
- Create operations require authentication
- Update/Delete operations require ownership (author match)
- Admin-only operations: tag PATCH/DELETE

### Sync Pattern
Tags and markers use PUT with complete replacement:
- Delete all existing records
- Create new records from request body
- Returns complete updated list

### Pagination
GET list endpoints use pagination headers and query params via DbService.

### Resource Types
Tags are resource-agnostic and can be attached to: crux, path, theme.
