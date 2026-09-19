# Spec: TV-first Discover and the Titan catalogue adapter

Status: implemented for the structure and the unconfigured state. No live catalogue query has succeeded, because no Titan catalogue contract has been supplied.

## Problem

Discover must be a separate, TV-first experience from Movie Jam. It may show only real, authorized catalogue records with their own titles, artwork, metadata, availability and attribution. It must never present generated Movie Jam artifacts, invented titles, or an invented provider endpoint as a real catalogue.

## Access probe (2026-09-19)

- `TITAN_API_KEY` exists in the local ignored `.env.local`. No base URL, endpoint path, request shape, or response schema for a Titan catalogue accompanies it anywhere in this repository or the preparation material.
- The prepared provider strategy records Titan as product context for the TV challenge with "no Titan API assumed".
- The only published Titan developer surface, `https://docs.titanos.tv/titan-sdk`, was fetched. The Titan SDK exposes device info, accessibility, app launch and remote-control key mapping. It publishes no catalogue, content, title-metadata or search API, and no keyed HTTP catalogue endpoint.

Conclusion: a credential exists, an authorized catalogue contract does not. This change therefore ships the verifiable structure plus an explicit `catalogue_not_configured` state. It does not guess a base URL and does not fabricate titles.

## Contract this adapter expects

The adapter is configuration-driven. It calls an operator-supplied endpoint; it never derives one.

| Variable | Required | Meaning |
| --- | --- | --- |
| `TITAN_CATALOGUE_URL` | yes | Absolute `https` URL of the authorized catalogue search endpoint |
| `TITAN_API_KEY` | yes | Bearer credential for that endpoint |
| `TITAN_CATALOGUE_TIMEOUT_MS` | no | Upstream timeout, 1000–15000, default 6000 |

Request: `GET <TITAN_CATALOGUE_URL>?query=&page=&pageSize=` with `Authorization: Bearer <key>` and `Accept: application/json`.

Expected response body, validated with Zod and rejected otherwise:

```json
{ "items": [ { "id": "string", "title": "string", "year": 1990, "synopsis": "string",
               "genres": ["string"], "runtimeMinutes": 101, "rating": "PG-13",
               "posterUrl": "https://…", "backdropUrl": "https://…",
               "attribution": "string",
               "availability": [ { "provider": "string", "kind": "stream|rent|buy|free", "url": "https://…" } ] } ],
  "total": 0, "page": 1, "pageSize": 24 }
```

If a supplied contract differs, change only `api/_lib/titan-catalogue.ts`; the internal response contract stays stable.

## Internal contract

`GET /api/catalogue?query=&page=&pageSize=` returns one of:

- `200 { "status": "ok", "source": "titan", "items": [...], "page", "pageSize", "total", "hasMore", "attribution" }`
- `200 { "status": "catalogue_not_configured", "code": "CATALOGUE_NOT_CONFIGURED", "safeMessage", "missing": ["TITAN_CATALOGUE_URL"] }`
- `4xx/5xx { "status": "error", "code", "safeMessage", "retryable" }`

`items` are never invented. `status: "ok"` with an empty `items` array means the authorized catalogue returned no match.

## Rules

- Catalogue identifiers are namespaced `cat:<provider id>`. Generated Jam artifacts use their own identifiers and are never rendered by Discover.
- Only `https` image and availability URLs survive validation; any other scheme is dropped.
- Query is capped at 120 characters, `pageSize` at 48, `page` at 100.
- Per-instance, per-client rate limit; bounded upstream body; timeout; typed errors that never carry the credential, the upstream URL, or the upstream body.
- Discover is keyboard-first: roving tab index over the result grid, arrow-key traversal, `Enter` to open a title, `Escape` to close, visible focus at couch distance.

## Verification

- `pnpm typecheck`, `pnpm build`, `pnpm test` (adapter and validation unit tests), and `scripts/smoke.mjs` covering `/discover` and `/api/catalogue`.
- Unit tests exercise the adapter against injected upstream responses: unconfigured, valid, malformed, oversized, timeout and upstream failure.
