<div align="center">
  <img src=".github/banner.jpg" alt="Crux Garden API — grow anything" width="100%">
</div>

# Crux Garden API

**grow anything** — the service behind a local-first creative workspace.

Crux Garden lets people make things with or without AI, keep their history, and publish
when ready. A **Crux** is a creative project; **Artifacts** are its files; **Growth** is
its version history. Gardens organize related Cruxes.

This repository contains the NestJS API and the packaged local runtime used by the
[desktop app](https://github.com/CruxGarden/app). The hosted API owns account authentication,
sync, publication, server-side Crux Store/Function access, and configured included
collaboration. The local runtime owns the desktop SQLite database and content manifests.
BYOK calls go directly from the app to the person's selected provider; included
collaboration uses the metered [inference service](src/inference/inference.service.ts).

The HTTP service uses PostgreSQL, Knex, and Redis. Hosted authentication and publication
need the corresponding deployment configuration; development email/storage mocks do not
prove live delivery. See `.env.example`, `CONTRIBUTING.md`, and `SECURITY.md`.

## Local runtime

This repository ships two deployment boundaries. The hosted NestJS application uses
PostgreSQL/Redis and exposes authenticated HTTP services. The desktop's
`@cruxgarden/local-api` package runs in-process inside Electron with native SQLite;
it does not start the hosted HTTP application or require cloud credentials for
local creation. Neither deployment is a second synchronized writer for the other's
live database.

| Responsibility                                                            | Source                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Public local package exports                                              | [src/local/index.ts](src/local/index.ts)                                                                                           |
| Connection ownership, command queue, lifecycle and change notifications   | [graph-runtime.ts](src/local/graph-runtime.ts)                                                                                     |
| File selection, immutable heads and admitted write/delete/rename commands | [file-content.service.ts](src/local/file-content.service.ts), [file-content.repository.ts](src/local/file-content.repository.ts)   |
| Automatic edit retention and marked versions                              | [edit-retention.service.ts](src/local/edit-retention.service.ts), [growth-content.service.ts](src/local/growth-content.service.ts) |
| Task review/merge and retained states                                     | [task-merge.service.ts](src/local/task-merge.service.ts), [working-copy-create.ts](src/local/working-copy-create.ts)               |
| Private graph archive and admission                                       | [private-graph-archive.ts](src/local/private-graph-archive.ts), [graph-transfer.service.ts](src/local/graph-transfer.service.ts)   |
| Installation recovery inspection                                          | [desktop-recovery.ts](src/local/desktop-recovery.ts), [desktop-content.ts](src/local/desktop-content.ts)                           |
| Packaging and packaged-runtime smoke check                                | [package-local-runtime.mjs](scripts/package-local-runtime.mjs), [check-local-runtime.cjs](scripts/check-local-runtime.cjs)         |

The host supplies exact Project Folder grants and filesystem projection. Native
commands validate expected heads/file selections and own the database transaction.
A guarded file mutation records its committed head and durable projection intent
together; the host finishes that admitted operation and retains recovery bytes.
External file changes are indexed through ingestion. A retry finishes an existing
intent, rather than repeating a destructive command with new implicit consent.
See the public [app architecture guide](https://github.com/CruxGarden/app/blob/main/docs/architecture.md)
for IPC, Project Folder recovery, workspace lifetime, previews and editor behavior.

These are the contributor decision boundaries:

- Keep one local runtime owner for the working database; renderer stores project
  state and issue named commands, never parallel raw SQL mutations.
- Preserve captured owner, revision and account context across asynchronous work.
  A stale selection or matching UUID does not authorize replacement.
- Private graph transfer, complete installation recovery and public output have
  distinct scopes. Keep credentials, machine paths and unrelated operational
  state outside portable project content.
- Retained file roots and fingerprints must remain readable through refusal,
  retry and restart. Routine autosave retention is distinct from marked versions
  and explicit destructive-operation safety states.
- Filesystem projection belongs to the trusted desktop host; downloaded editor
  packages do not install privileged host code.

These public summaries and their source links stand alone. A contributor does not
need a private parent workspace or unpublished ADRs to identify the current owner.
Describe proposed boundary changes, alternatives and preservation tests in the PR,
and update the relevant public guide when behavior changes.

To produce the local package from this checkout:

```bash
nvm use
npm ci
npm run build:local
npm run verify:local
```

`build:local` builds the API and writes `build/local-runtime/` with compiled code,
declarations, license and provenance. `verify:local` packages the existing build
and smoke-tests the actual runtime. The package version includes the API source
revision and artifact hash. The app vendors the resulting npm archive in
`electron/vendor/`; both its Node test fixture and Electron dependency must select
that same archive. Keep their native SQLite installations separate. A source-only
API change is not installed in the app until those consumer dependencies change.
Full API verification and affected app/host/actual-desktop checks remain required
for a changed runtime; see [CONTRIBUTING.md](CONTRIBUTING.md#local-runtime-changes).

## Getting Started

### Prerequisites

- Node.js 22 (see `.nvmrc`)
- Docker (recommended) or PostgreSQL and Redis

### Quick Start

Copy the environment template:

```bash
cp .env.example .env
```

Edit `.env` and set your `JWT_SECRET` (minimum 32 characters). Other variables have sensible defaults or will run in mock mode.

### Option 1: With Docker (Recommended)

```bash
npm run setup  # Install dependencies, start Docker containers, run migrations
npm run dev    # Start development server
```

### Option 2: Without Docker

Using your own PostgreSQL and Redis:

```bash
# Update .env with your database and Redis URLs:
# DATABASE_URL=postgresql://user:password@localhost:5432/cruxgarden
# REDIS_URL=redis://localhost:6379

npm ci              # Install dependencies
npm run migrate:dev # Run migrations
npm run start:dev   # Start development server
```

The API will be available at `http://localhost:3000`. Visit `http://localhost:3000/docs` for interactive API documentation.

## Running Tests

The suite includes real SQLite file, archive and restart workflows. Jest uses two workers and a 30-second default budget for these operations; tests of runtime deadlines keep their explicit limits. Integration tests run serially.

`npm run verify` is the release gate: lint, unit tests, HTTP integration tests, build, and the packaged local-runtime smoke check. The integration gate requires a running Docker engine. Its PostgreSQL fixture starts a disposable `postgres:16-alpine` container on a random loopback port, applies the real migrations, and removes the container afterward. It never reads database credentials from `.env` or connects to an existing database. The image is downloaded on first use if it is absent. No Redis server is needed for these fixtures.

```bash
npm run test             # Unit tests
npm run test:integration # Integration tests
npm run test:all         # All tests
```

## Environment Variables

**Required:**

- `JWT_SECRET` - JWT token signing secret (minimum 32 characters)

**Database & Cache** (auto-configured with Docker):

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string

**AWS Services** (optional - runs in mock mode if not configured):

- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_REGION` - AWS region (e.g., `us-east-1`)
- `AWS_SES_FROM_EMAIL` - Email sender address
- `AWS_S3_ARTIFACTS_BUCKET` - S3 bucket for artifact storage

Without AWS credentials, emails and file operations are logged to console. See `.env.example` for additional configuration options.

## Contributing

Please read our [Contributing Guide](CONTRIBUTING.md) for details on:

- Setting up your development environment
- Code style and standards
- Testing guidelines
- Commit message conventions
- Pull request process

## Security

If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) to report it responsibly.

## Community

- **Report bugs** via [GitHub Issues](https://github.com/CruxGarden/api/issues)
- **Request features** via [GitHub Issues](https://github.com/CruxGarden/api/issues)
- **Ask questions** via [GitHub Discussions](https://github.com/CruxGarden/api/discussions)
- **Contribute** by submitting pull requests

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
