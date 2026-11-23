---
type: api
priority: high
area: api
---

# Preserve API documentation endpoints

## Purpose & Context

Migrate `api` from the deprecated `@elysiajs/swagger` fork (`zoriya/elysia-swagger#build` in `api/package.json`) to the maintained `@elysiajs/openapi` plugin. This fulfills the accepted security-gate recommendation to remove the unmaintained fork dependency while preserving existing documentation endpoints, multi-service Scalar aggregation, and current authentication and public API behavior.

## Actors and Roles

- **API consumer**: Unauthenticated read-only user accessing `/swagger` (Scalar UI) and `/swagger/json` (OpenAPI JSON specification).
- **Server maintainer**: Controls OpenAPI metadata, server URLs, and Scalar source configuration in `api/src/index.ts`. No client-side configuration overrides are permitted.

## Implementation Requirements

1. Replace `@elysiajs/swagger` (`zoriya/elysia-swagger#build`) with `@elysiajs/openapi` in `api/package.json` and update `api/src/index.ts`.
2. Configure `@elysiajs/openapi` with explicit `path: "/swagger"` and `specPath: "/swagger/json"` so the existing routes do not shift to plugin defaults.
3. Preserve the existing `documentation` object (`info`, `servers`, `tags`) in `api/src/index.ts`.
4. Preserve the four server-controlled Scalar sources in the plugin configuration:
   - `kyoo`: `/swagger/json`
   - `keibi`: `/auth/swagger/doc.json`
   - `scanner`: `/scanner/openapi.json`
   - `transcoder`: `/video/swagger/doc.json`
5. Keep all Scalar and OpenAPI options static and server-controlled; do not read `url` or `sources` from request query parameters, headers, or user input.
6. Leave all authentication, authorization, and public API route contracts unchanged.
7. Verify the migrated endpoints and run all lint, typecheck, and test suites without bypassing any release checks.

## Inputs & Outputs

### Endpoints

| Method | Path | Auth | Content-Type | Response |
|--------|------|------|--------------|----------|
| `GET` | `/swagger` | None | `text/html` | `200 OK` Scalar UI configured with the four server-defined sources |
| `GET` | `/swagger/json` | None | `application/json` | `200 OK` OpenAPI JSON specification for Kyoo |

### Input constraints

- No query parameters, headers, or request bodies are accepted to modify Scalar `sources`, target `url`, or OpenAPI `servers`.

## Edge / Failure Cases

- **Default path drift**: Omitting explicit `path` and `specPath` causes `@elysiajs/openapi` to serve `/openapi` and `/openapi/json`, returning `404 Not Found` on `/swagger` and `/swagger/json`.
- **Missing Scalar source**: Omitting or renaming any of the four `sources` entries breaks documentation switching for `keibi`, `scanner`, or `transcoder`.
- **Client-controlled config**: Accepting external `url` or `sources` parameters introduces untrusted spec loading; configuration must remain hardcoded on the server.
- **Downstream service unavailable**: If `keibi`, `scanner`, or `transcoder` is unreachable, `/swagger` and `/swagger/json` for `kyoo` must still return `200 OK`.

## Acceptance Criteria

- [ ] `@elysiajs/swagger` (`zoriya/elysia-swagger#build`) is removed from `api/package.json` and replaced by `@elysiajs/openapi` with an updated lockfile.
- [ ] `GET /swagger` returns `200 OK` HTML rendering Scalar with all four server-controlled sources (`kyoo`, `keibi`, `scanner`, `transcoder`).
- [ ] `GET /swagger/json` returns `200 OK` valid OpenAPI JSON preserving Kyoo's `info`, `servers`, `tags`, and route definitions.
- [ ] Scalar configuration is strictly server-controlled with no request-driven source or URL overrides.
- [ ] Authentication, authorization, and public API route contracts remain unchanged.
- [ ] Endpoint verification, typecheck, lint, and tests pass with no bypass of release checks.

## Constraints / Non-goals

- Adding authentication or rate limiting to `/swagger` or `/swagger/json`.
- Changing public API routes, request/response schemas, or OpenAPI metadata beyond the plugin migration.
- Adding, removing, or renaming the four Scalar documentation sources.
- Skipping or bypassing CI, lint, or release verification gates.
