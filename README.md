# Hearth

A tiny household operating board for a family of five: who does which chore, what we are out
of, and whether the week's work is being shared fairly. Runs on one computer at home and works
on every family member's phone over the home Wi-Fi. Node 22 built-ins only, no dependencies.

## Run

```
cd hearth
npm run dev            # http://127.0.0.1:4317
HOST=0.0.0.0 npm run dev   # phones on the home network: http://<this-computer-ip>:4317
```

`PORT` is also overridable. Stop with Ctrl+C; the store is flushed on the way out.

## Test

```
npm run lint   # syntax check on server and lib
npm test       # node:test suites in test/ (API on port 0 + store unit tests)
```

## Demo script

1. Open the board. Three chores are already done this week, so the fairness bars are alive.
2. Tap **Tapiwa** under "Who's here?". Tick **Feed Simba the dog** as done; watch Tapiwa's bar
   grow and the fairness number change. Open the page on a second device: it updates live.
3. Add a chore ("Mop the kitchen", Chiedza, 3 points, Wed). It appears under Wednesday.
4. Press **Rotate fairly**: open chores move to whoever has done the least, biggest chores first.
5. Under "We're out of...", add "Eggs, 12" and press **Got it** on Milk; it collapses into
   "Bought this week". Call `POST /api/reset` to start the demo over.

## API

All under `/api`, JSON in and out. Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | Members, chores, shopping, `week.points`, `week.fairness` |
| POST | `/api/chores` | `{ title, assigneeId, points 1-10, dueDay Mon..Sun }` -> 201 |
| PATCH | `/api/chores/:id` | `{ status?, assigneeId?, actorId }` |
| DELETE | `/api/chores/:id` | 204 |
| POST | `/api/chores/rotate` | Fair rotation of open chores, returns state |
| POST | `/api/shopping` | `{ name, qty?, actorId }` -> 201 |
| PATCH | `/api/shopping/:id` | `{ status: needed or bought, actorId }` |
| DELETE | `/api/shopping/:id` | 204 |
| POST | `/api/reset` | Reseed the Moyo family demo data |
| GET | `/api/events` | Server-sent events: a `state` event on connect and after every change |

The full contract lives in `openapi.yaml`; the product spec in `docs/SPEC.md`.

## Scope decisions

- **No accounts, no auth.** Hearth trusts the home LAN. Whoever can reach the computer can act
  as any family member; the "Who's here?" switcher is a courtesy, not a lock. Do not expose it
  to the internet without putting it behind something that authenticates.
- **One household, one process.** State is a single JSON document held in memory and written
  atomically after every change. That is plenty for a family; a second household would mean a
  second process (or a real database).
- **Fairness = lowest / highest points this week.** Simple, explainable at the dinner table, and
  honest about the one person doing nothing (score 0).
- **Rotation is greedy.** Biggest open chore first, to the person with the lowest running total.
  Not optimal in theory; fair enough in practice and easy to argue about out loud.

## Where data lives

`hearth/data/hearth.json`, created on first boot and rewritten (write `.tmp`, then rename) after
every change. The folder is in `.gitignore`. Delete the file, or `POST /api/reset`, to start over.

## Browser-origin guard

There is no login, so the browser's own headers are the trust boundary. Requests with a foreign
`Host` get 421 (stops DNS rebinding); changes from another site's page get 403 (stops CSRF);
bodies that are not JSON get 415. Add extra hostnames with `HEARTH_ALLOWED_HOSTS=hearth.local`.

## Hosted demo (Vercel)

The same code runs on Vercel as a public demo. `public/` is served as static files and every
`/api/*` request goes to one function, `api/[...path].mjs`, which wraps the same app the local
server runs. Config lives in `vercel.json` (region `cpt1`, Cape Town).

What differs from the home setup, on purpose:

- **State is per instance and temporary.** It lives in the function's memory and temp directory,
  so the board starts from the seed whenever a fresh instance boots, and two instances would not
  share a board. Fine for a demo; a real household should run it at home, or add a shared store
  (for example Redis with pub/sub) first.
- **Anyone with the link can edit.** The page says so on any non-home address. Use
  `POST /api/reset` (or wait for the board to go idle) to get the seed back.
- **Live updates reconnect every few minutes.** Streams end after 240 s, before the platform's
  300 s limit, and the browser reconnects within 2 s.
- **Host check.** Only the deployment's own hostnames (Vercel's `VERCEL_URL`,
  `VERCEL_BRANCH_URL` and `VERCEL_PROJECT_PRODUCTION_URL`) are accepted. Add a custom domain with
  the `HEARTH_ALLOWED_HOSTS` environment variable.

Deploys happen from GitHub: a merge to `main` is a production deploy.
