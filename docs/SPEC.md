# Hearth: technical specification

Status: v0.1, demo-ready. Companion contract: [`../openapi.yaml`](../openapi.yaml). Read time: 5 minutes.

Hearth is a household operating board for one family on one home Wi-Fi: a single Node 22 process, no dependencies, one JSON file, every phone sees the same live state.

## 1. Problem and users

Household work is invisible, unevenly shared and tracked in one person's head, usually the mother's. The friction is not one big failure but dozens of small coordination failures a week.

| Name | Role | What they need from Hearth |
| --- | --- | --- |
| Rudo | Parent (carries the mental load) | Stop being the family's memory: see who owes what without asking. |
| Tendai | Parent | Pick up slack visibly and prove it; add to the shopping list from the car. |
| Anesu (16) | Child | Fair treatment: evidence she does more than her siblings, and credit for it. |
| Chiedza (13) | Child | A clear, short list of her own chores, and a way to tick them off from her phone. |
| Tapiwa (9) | Child | Big tap targets, an emoji and a colour that are his, and the thrill of the points number going up. |

Pain scenarios:

1. **The bins.** Collection is Tuesday morning. Nobody was told it was their turn, so nobody did it. The bins sit full for a week and the argument is about who was "meant to".
2. **Out of milk again.** Three people noticed the carton was empty; none of them wrote it down anywhere the shopper would look. The list lives in Rudo's head and WhatsApp scrollback.
3. **I did the dishes three times.** Anesu did; nobody noticed; Chiedza did them once and got the same thanks. Unseen effort breeds resentment, and resentment makes the next chore harder to hand out.

Product thesis: **make the work visible (one shared board), fair (points and a rotation that favours whoever has done least) and shared (every device on the home network sees the same state, live).**

## 2. Scope

In scope for v0.1:

- Chores with a title, assignee, points (1 to 10), due day and `todo`/`done` status, credited to whoever ticked them.
- Fairness: weekly points per member, a fairness ratio, and a one-tap "Rotate fairly" that reassigns open chores lowest-total-first.
- A shared shopping list (`needed`/`bought`) that anyone can add to.
- Live sync to every open browser via Server-Sent Events.
- Persistence to a JSON file with atomic writes; survives a restart.

Out of scope, and why:

| Not built | Why not now |
| --- | --- |
| Auth, accounts, PINs | The trust boundary is the Wi-Fi password. Login friction would kill adoption by a 9-year-old. |
| Calendar integration | Due day is enough for weekly chores; calendars are a different product. |
| Money and allowance | Points are the currency; converting to dollars is a family policy decision, not a v0.1 feature. |
| Push notifications | Needs a cloud relay and device tokens. The board being open on the kitchen tablet is the notification. |
| Cloud hosting | Would require auth, TLS and a tenant model. The whole point is that it runs at home. |
| Multi-household | One family per process. Tenancy is deferred, but every record already lives under one `State` root so a `householdId` can wrap it later. |

**20-minute build, 5-year mindset.** The code is small, but the seams are the ones a larger system would have: a pure domain layer (`week`, `fairness`, `rotate`) with no I/O; a store interface with exactly three operations (`load`, `mutate`, `subscribe`) that a SQLite or Postgres adapter could implement without the HTTP layer noticing; a typed contract (`openapi.yaml`) that a native client could be generated from; and full-state broadcast, which makes a future diff protocol an optimisation rather than a rewrite. Nothing is built ahead of need, but nothing blocks the next step either.

## 3. Architecture

```
  Phones + laptop on home Wi-Fi
  +----------+ +----------+ +----------+
  | Safari   | | Chrome   | | Tablet   |   vanilla HTML/CSS/JS from /public
  +----+-----+ +----+-----+ +----+-----+
       |  HTTP JSON  |  GET /api/events (SSE)
       v             v             v
  +----------------------------------------+
  | Node 22 http server  127.0.0.1:4317    |
  |  router -> validate -> domain -> store |
  |  SSE hub: broadcast full State         |
  +-------------------+--------------------+
                      | in-memory State (single source of truth)
                      v
  +----------------------------------------+
  | data/hearth.json  (write tmp, fsync,   |
  |                    rename over target) |
  +----------------------------------------+
```

Request lifecycle for a mutation (for example `PATCH /api/chores/:id`):

1. The browser sends JSON with the acting member's id (`actorId`), chosen from the picker.
2. The router matches method and path; unknown `/api/*` paths return 404.
3. The body reader enforces the 16 KB limit (413) and parses JSON (400 `bad_json` on failure).
4. Hand-rolled validators check every field against the contract in section 4 (400 `validation_error` with the field name).
5. The domain function produces the next `State` from the current one (pure, synchronous); the store serialises it, writes to a temp file, fsyncs and renames over `hearth.json`.
6. The handler returns the affected entity, then the SSE hub broadcasts the full `State` to every connected client, which re-renders.

Why SSE rather than WebSockets or polling: traffic is one-directional (server to clients) and tiny, mutations already travel over plain HTTP, and SSE is built into `http` and `EventSource` with automatic reconnection, so there is no handshake code, no framing and no library. Polling every few seconds would work but makes the "watch the other phone update" moment laggy and wastes battery on five devices. WebSockets would add bidirectional framing we never use.

## 4. Data model

All ids are opaque strings (`crypto.randomUUID()`). All timestamps are ISO 8601 strings in UTC. Unknown fields are rejected on input and never stored.

```
Member       { id, name, label, role: 'parent'|'child', emoji, color }
Chore        { id, title (1..60), assigneeId, points: int 1..10,
               dueDay: 'Mon'|'Tue'|'Wed'|'Thu'|'Fri'|'Sat'|'Sun',
               status: 'todo'|'done', doneBy: memberId|null, doneAt: ISO|null, createdAt: ISO }
ShoppingItem { id, name (1..60), qty: string(0..20)|null, addedBy: memberId,
               status: 'needed'|'bought', boughtBy: memberId|null, createdAt: ISO, boughtAt: ISO|null }
State        { members: Member[], chores: Chore[], shopping: ShoppingItem[],
               week: { start: ISO, points: {memberId: int}, fairness: 0..1 }, updatedAt: ISO }
```

Field constraints:

- `Member` is seeded (the five Moyos) and read-only through the API in v0.1. `label` is the short form shown on chips (for example "Mum"); `color` is a CSS hex colour.
- `Chore.title` and `ShoppingItem.name` are trimmed, 1 to 60 characters. `points` is an integer 1 to 10. `assigneeId`, `doneBy`, `boughtBy`, `addedBy` and `actorId` must reference an existing member.
- `status: 'done'` implies `doneBy` and `doneAt` are set; `status: 'todo'` implies both are `null`. Same invariant for `bought`/`boughtBy`/`boughtAt`. The server enforces it; clients never send these fields directly.
- `week` is derived, never stored: it is recomputed from `chores` on every read and broadcast.

**Week definition.** Monday 00:00:00 to Sunday 23:59:59.999 in the server's local time zone (Africa/Harare). `week.start` is that Monday in ISO.

**Points.** `points[memberId]` = sum of `chore.points` over chores with `status = 'done'` and `doneAt` inside the current week, credited to `doneBy`. Every member starts at 0, so the map always has five keys.

**Fairness.** `fairness = min(points) / max(points)`, or `1` when all values are equal (including all zero). A value of 1 means perfectly even; 0.25 means the busiest member did four times the least busy one.

**Rotation (pure function `rotate(state) -> state`).** Take all `todo` chores sorted by `points` descending. Start each member's running total at their current week points. For each chore, assign it to the member with the lowest running total; break ties by fewest open chores already assigned, then by seed order. Add the chore's points to that member's total and continue. Greedy largest-first is the classic LPT heuristic for balanced partitioning and gives an intuitive result a 13-year-old can audit.

## 5. API

Base path `/api`, JSON in and out, served from `127.0.0.1:4317` by default (`HOST=0.0.0.0` opts into the LAN, `PORT` overrides the port). Static files from `hearth/public/` at `/`.

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/state` | none | 200 `State` | |
| POST | `/api/chores` | `{ title, assigneeId, points, dueDay }` | 201 `Chore` | 400 |
| PATCH | `/api/chores/{id}` | `{ status?, assigneeId?, actorId }` | 200 `Chore` | 400, 404 |
| DELETE | `/api/chores/{id}` | none | 204 | 404 |
| POST | `/api/chores/rotate` | none | 200 `State` | |
| POST | `/api/shopping` | `{ name, qty?, actorId }` | 201 `ShoppingItem` | 400 |
| PATCH | `/api/shopping/{id}` | `{ status, actorId }` | 200 `ShoppingItem` | 400, 404 |
| DELETE | `/api/shopping/{id}` | none | 204 | 404 |
| POST | `/api/reset` | none | 200 `State` | |
| GET | `/api/events` | none | 200 `text/event-stream` | |
| any | other `/api/*` | | | 404 `not_found` |

Semantics: `PATCH` to `status: 'done'` sets `doneBy = actorId` and `doneAt = now`; `status: 'todo'` clears both. `POST /api/reset` reseeds the demo data and is kept deliberately for the presentation. Every mutation (201, 200, 204 on a write, rotate, reset) triggers one SSE broadcast.

Error envelope, for every non-2xx response:

```json
{ "error": { "code": "validation_error", "message": "points must be an integer between 1 and 10" } }
```

Codes: `bad_json` (400), `validation_error` (400), `not_found` (404), `payload_too_large` (413, body over 16 KB), `internal` (500).

SSE protocol on `GET /api/events`: the server responds with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, then immediately sends `event: state` with the full `State` JSON as `data:`. After every mutation it sends the same event again. Every 25 seconds it writes a comment line `: ping` so proxies and mobile radios keep the connection open. There is no client-to-server channel; clients use the HTTP endpoints above.

## 6. Key decisions

**ADR-1 Zero dependencies.** Context: a demo that must run on any laptop with Node 22 and nothing else, assessed partly on scope judgment. Decision: `node:http`, `node:fs/promises`, `node:crypto`, `node:test` only. Consequences: no supply chain, no install step, no lockfile drift; we hand-roll about 80 lines of routing and validation. Revisit when a second developer joins or the route count passes roughly 20.

**ADR-2 JSON file with atomic rename, not SQLite or Postgres.** Context: one household, five users, a few hundred records a year, one process. Decision: hold `State` in memory, write `hearth.json.tmp`, `fsync`, `rename` over the target. Consequences: crash-safe at file granularity, trivially inspectable and backed up by copying a file; no concurrent writers, no queries, whole-file rewrite per mutation (fine below a few megabytes). Revisit when there is more than one process, when history and reporting need queries, or when the file passes about 1 MB.

**ADR-3 Full-state broadcast instead of diffs.** Context: `State` is a few kilobytes and there are at most a handful of clients. Decision: every SSE event carries the complete `State`; the client re-renders from it. Consequences: no reconciliation bugs, reconnect is trivial (the next event is the truth), idempotent by construction; bandwidth grows with state size. Revisit when `State` exceeds roughly 100 KB or there are dozens of clients.

**ADR-4 Identity by picker, not login.** Context: a 9-year-old and a shared kitchen tablet. Decision: each client picks "who am I" from the five members and sends `actorId` on writes; the server records it but does not verify it. Consequences: zero friction, honest-by-default accounting within a family that trusts each other; a sibling can tick as another sibling. Revisit when the family wants accountability: a per-member PIN (roadmap slice 1).

**ADR-5 Points with lowest-total-first rotation.** Context: "fair" must be legible to children. Decision: points per chore, weekly totals, a ratio and a greedy largest-first assignment. Consequences: one number everyone understands, an audit trail (`doneBy`, `doneAt`), and rotation that favours whoever has done least this week; it ignores age and ability beyond what the points encode. Revisit if the family wants weighting per member or multi-week memory.

**ADR-6 Bind to 127.0.0.1 by default, LAN opt-in.** Context: no auth. Decision: the server listens on loopback unless `HOST=0.0.0.0` is set explicitly. Consequences: running it by accident exposes nothing; the demo requires one deliberate flag to reach phones. Revisit never: an unauthenticated service should always default closed.

**ADR-7 Vanilla front end, no framework.** Context: one page, one state object, re-rendered on every event. Decision: HTML, CSS and a `render(state)` function. Consequences: no build step, loads instantly on a 2018 phone, about 300 lines of JS; no component model when the UI grows. Revisit when there are more than three views or when forms carry local state that full re-render would clobber.

**ADR-8 Hand-rolled validation, not zod.** Context: ADR-1, and a contract with eight fields. Decision: small `assertString(min, max)`, `assertEnum`, `assertInt` helpers producing `validation_error` messages. Consequences: readable errors, no dependency, but the rules live in two places (`openapi.yaml` and code) and must be kept in step by hand. Revisit when the contract grows past about 20 fields or a TypeScript client wants shared types.

## 7. Quality

Test strategy: `node:test` spawns the real server on port 0 with `HEARTH_DATA` pointing at a temp file, exercises it over `fetch`, and asserts on both responses and the file on disk. The nine cases: (1) `GET /api/state` returns the seed with five members; (2) create a chore returns 201 and appears in state; (3) rejecting `points: 11` and a 61-character title with `validation_error`; (4) marking done sets `doneBy`/`doneAt` and adds points for the week; (5) marking todo clears them and removes the points; (6) `rotate` is pure and balances a known fixture to a predicted assignment; (7) shopping add, buy, delete round-trip; (8) malformed JSON gives 400 `bad_json`, a 17 KB body gives 413; (9) restart the server against the same file and the state is intact. The SSE handshake is covered by asserting the first `event: state` frame arrives within one second.

Local gate: `npm run lint && npm test` (lint is `node --check` over every source file plus a tab and trailing-whitespace grep; there is no linter dependency, see ADR-1). CI is not configured; the gate runs before every commit.

Input validation and limits: body cap 16 KB (413), JSON parse guarded (400), every field checked for type, length, enum and referential integrity against members (400), unknown fields rejected, ids must exist (404). Header size is left to Node's default (16 KB).

Failure modes:

| Failure | Behaviour |
| --- | --- |
| `hearth.json` missing | Seed the demo data and write it. |
| `hearth.json` corrupt (parse error or shape mismatch) | Log a warning with the path, rename the bad file to `hearth.json.corrupt-<timestamp>`, reseed. Nothing is silently discarded. |
| Disk full or write error during a mutation | The mutation returns 500 `internal`; in-memory state is rolled back to the pre-mutation snapshot so memory and disk never disagree. |
| SSE connection drops (phone sleeps, Wi-Fi blips) | `EventSource` reconnects automatically; the first event after reconnect is the full state, so the client simply re-renders. No missed-event bookkeeping. |
| Server restarts | Clients reconnect and re-render; state comes from the file. In-flight mutations fail visibly in the UI. |

## 8. Security and privacy posture

Threat model: the attacker is someone on the home Wi-Fi. In this household that is the five Moyos and their guests. Data at stake: first names, chore titles and a shopping list; nothing financial, no credentials, no location.

Protected: the server defaults to loopback (ADR-6); every request must carry a `Host` of localhost, a private LAN address or a name in `HEARTH_ALLOWED_HOSTS` (else 421 `host_not_allowed`), which defeats DNS rebinding; every mutation must come from the Hearth page itself (`Origin` absent or same-origin, else 403 `cross_site_request`) and carry `Content-Type: application/json` when it has a body (else 415), which defeats cross-site request forgery from other open tabs; input is validated and size-limited, so a misbehaving client cannot corrupt the file or exhaust memory; writes are atomic, so a crash cannot leave a half-written file; no third-party code runs on the server or in the browser; nothing leaves the LAN.

Not protected: there is no authentication, so anyone on the LAN can read and write everything, including acting as another member; there is no TLS, so traffic is readable on the Wi-Fi; there is no rate limiting; the data file is plain text on disk.

Before any exposure beyond the LAN, three things are required, in this order: (1) **authentication**, at minimum a per-member PIN with a server-side session cookie and parent-only access to reset and delete; (2) **TLS** via a reverse proxy (Caddy) with a real hostname, and `SameSite=Strict` cookies plus an `Origin` check on mutations; (3) **abuse controls**: per-IP rate limits, an append-only audit log of who changed what, and backups of `hearth.json`.

## 9. Running and demo script

```
cd hearth
node server.mjs                      # http://127.0.0.1:4317, laptop only
HOST=0.0.0.0 node server.mjs         # also reachable from phones on the Wi-Fi
npm run lint && npm test             # the local gate
```

Five-step demo (two browser tabs on the laptop, or laptop plus one phone on the same Wi-Fi):

1. Open the board on both devices. Pick "Rudo" on the laptop and "Anesu" on the phone. Point out the fairness number and that every member is at 0.
2. On the phone, tick "Take out the bins" as done. Watch the laptop update without a refresh; Anesu's points climb and the fairness number drops below 1.
3. On the phone, add "Milk" to the shopping list. It appears on the laptop instantly: the "we're out of milk again" problem, solved in one tap.
4. On the laptop, press **Rotate fairly**. Open chores move to the members with the lowest totals; explain that the number is lowest-over-highest and the rotation is a pure function anyone can audit.
5. Kill the server and start it again. Both screens reconnect and show the same state: the file persisted it.

## 10. Roadmap (next 3 slices)

1. **PIN per member and parental approval of "done".** A 4-digit PIN unlocks the picker; a child's "done" becomes `pending` until a parent confirms. Closes the ADR-4 gap and introduces a third chore status.
2. **Allowance ledger from points.** A parent-set rate converts weekly points to an allowance line per child, with a ledger of payouts. Reuses `week.points`; adds the first money record.
3. **Weekly digest to the family WhatsApp group.** Sunday evening summary (points, fairness, what is still open, what to buy) via the WhatsApp Business API or a copy-to-clipboard fallback. The first feature that leaves the LAN, so it lands after the section 8 prerequisites.
