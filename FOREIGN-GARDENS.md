# Cruxes and people from other gardens

Status: **draft**, 2026-09-18. Records what the existing model already decides, and marks what it does not. Follows [ADR 0049](../docs/adr/0049-a-garden-is-whole.md).

An earlier draft of this file invented an `origin` column and a `gardens` registry table. Both were wrong: the model already has a place for this and it is not a new table. Recorded so it is not reinvented.

## What is already decided

**The home is the garden is the crux.** An author's `root_id` references a Crux (live, in the init migration; `homeId` in `archive/LOCAL-FIRST-SYSTEM.md`). A garden is not a separate entity with its own table — it is a Crux, and so is a person, because an author *is* their home Crux. Another garden is therefore reachable and relatable like anything else in the graph, identified by its UUID.

**Four dimension types, and two of them are reserved for exactly this** (`DimensionType` in `api/src/common/types/enums.ts`, purposes in `archive/SYNC-SYSTEM.md`):

| Dimension | Purpose | State |
| --- | --- | --- |
| `growth` | Version history — how a Crux developed | Built |
| `garden` | Creations and consequences that emerged from a Crux | Reserved |
| `graft` | Lateral connections and associations | Reserved |
| `gate` | The published entrance | Built (publish) |

So `garden` is containment — a home Crux with garden dimensions to everything grown in it — and `graft` is the lateral link, which is what a connection to something from elsewhere is.

**Provenance is a dimension, not a column.** Where something came from is an edge in the graph, which is why no origin field is needed and no registry table exists.

**Identity, from ADR 0049.** The UUID is the identity; `@username` is unique per garden and is display only. A garden never grants a foreign handle on the strength of it being held elsewhere.

**Auth, from ADR 0049.** Each garden is its own realm with its own email+code flow. A token from one garden means nothing in another. The UUID is shared; the credential never is.

## What was never worked out

These are open, not lost. Daniel confirmed the original design did not cover them.

- **Placement on arrival.** When a Crux comes from another garden, does it get a `graft` to its source, a `garden` dimension from your home, or both? The answer decides whether grafted work shows up in your garden's listings by default.
- **Whether a foreign author is materialised locally.** An author is a Crux, so the question is whether that Crux is stored here or only referenced.
- **Resolving a garden's address from its Crux.** A UUID identifies; a Gate locates. What holds the current address, and what happens when a garden moves.
- **Second arrival.** The same Crux arriving twice is a merge under [ADR 0048](../docs/adr/0048-merging-a-crux-across-gardens.md), not an insert — but the trigger, and who is asked, are unspecified.
- **Slug collision.** Slugs are unique per author per garden; an arriving Crux may want one that is taken.
- **Trust and discoverability.** Foreign content is untrusted input. Whether `discoverable` is inherited or is the receiving keeper's choice is undecided — ADR 0049 assumes the latter, which is a position, not a decision.

## Consequence for the database

A Home Garden runs the API on SQLite beside the app; a garden hosting members runs it on Postgres. Both, not either — so raw SQL must be dialect-neutral rather than ported once. Measured today: 27 `whereRaw`/`orderByRaw`/`.raw(` sites, 9 `ilike`, 18 Postgres-isms, 8 `jsonb` columns, 25 `onConflict`/`returning` (both supported by modern SQLite).

The client side is a separate blocker and not an API concern: `cruxgarden:accessToken` / `cruxgarden:refreshToken` is a single global pair in `localStorage`. Belonging to more than one garden needs one credential per garden, a list of known gardens, and a current one.
