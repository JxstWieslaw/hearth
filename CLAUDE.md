# Hearth

Household operating board for a family of five. Zero-dependency Node 22, vanilla front end.

## Commands
- `npm run dev`: local server on http://127.0.0.1:4317 (`HOST=0.0.0.0` for phones on the LAN)
- `npm run lint`: `node --check` over the server and libs
- `npm test`: node:test suites in `test/` (real server on port 0, temp data file)

## Layout
- `server.mjs`: HTTP app (`createApp` returns `{ server, shutdown, handle }`), routes, SSE, guard
- `lib/store.mjs`: in-memory state, atomic JSON persistence, pure fairness functions
- `lib/validate.mjs`: hand-rolled validators
- `public/`: static UI; `api/hearth.mjs` (vercel.json rewrites `/api/*` to it): Vercel entry point; `vercel.json`: hosting config
- `docs/SPEC.md` and `openapi.yaml`: the spec and API contract; keep them in step with the code

## Conventions
- No runtime dependencies. Explain any new one in the PR.
- Branches off `develop`; PRs to `develop`; `develop` → `main` releases. A merge to `main` deploys.
- Conventional commits with a scope, e.g. `fix(hearth): ...`.
- On Windows use `node --test "test/*.test.mjs"`; the directory form fails on Node 22.
- Don't weaken the Host / Origin / content-type guard in `server.mjs`.
