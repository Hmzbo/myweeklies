# Architecture

## 1. Shape

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  PWA phone  │     │ PWA desktop │     │ PWA desktop │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │ HTTPS             │                   │
       └───────────┬───────┴───────────────────┘
                   ▼
         ┌───────────────────┐
         │      Server       │
         │  Fastify + SQLite │
         └─────────┬─────────┘
                   ▼
         ┌───────────────────┐
         │  packages/core    │
         │  pure domain      │
         └───────────────────┘
```

One server, one SQLite file, any number of clients. Single-user by design: no
authentication, no user table, no sharing.

---

## 2. The layers

### `packages/core` — pure domain

No I/O. No framework. No database. No clock unless injected.

This is the most important structural constraint in the repository, and it exists
for one reason: **the parts that are hard to get right are the parts that must be
exhaustively testable.** Recurrence expansion, the occurrence generator, and the
statistics are all subtle. Making them pure means they can be tested as tables of
input → output rather than through a stack of mocks.

Contents:

| Module | Responsibility |
|---|---|
| `dates.ts` | Calendar-date arithmetic and timezone helpers |
| `calendars.ts` | Gregorian/Hijri conversion over `Intl`, no dependency |
| `rrule.ts` | The only file that imports an RRULE library |
| `types.ts` | Domain types and the status model |
| `generator.ts` | The occurrence planner |
| `applyPlan.ts` | Pure plan application, used by tests |
| `stats.ts` | Adherence, streaks, trends, reports |
| `interop.ts` | Backup validation, CSV ledger, VTODO schedules |

### `packages/server` — persistence and API

All SQL lives in `repo.ts`. Routes in `app.ts` call repository functions and
contain no queries.

Responsibilities:

- SQLite persistence and migrations
- HTTP API
- Running the generator before serving anything that touches the ledger
- Web Push scheduling, which can run without a client open
- JSON backup/restore and CSV/VTODO export

### `packages/web` — PWA client

React + Vite. A browser cache over the server, never a source of truth.

### `packages/desktop` — Tauri shell, sidecar server

A double-clickable Windows app around the same two bundles: the window loads
the sidecar-served PWA over loopback, so everything stays same-origin and no
web code changes. The sidecar is a stock Node runtime plus the server bundle
and the native closure, assembled per platform; data lives in `%APPDATA%`,
never the repo.

### `packages/companion` — Capacitor shell for Android

The same web UI in a native WebView, pointed at a home server over LAN. A
native shell has no PWA installability rules to satisfy, so there are no
browser flags and no Tailscale: first launch shows a Connect screen (paste a
pairing code or enter address + secret), and the stored server URL plus bearer
token prefix every API call. Reminders travel over ntfy; no native
notification code in v1.

---

## 3. Source of truth

**The server.** Clients are replicas that read from it and submit writes.

This was chosen deliberately over two alternatives:

- *Phone as source of truth, desktop as thin client* — rejected because Android
  does not reliably run background code (Doze, battery optimisation, OEM kill
  lists), because it is a single point of failure, and because it is the worst
  possible installation story for other users.
- *Peer-to-peer mesh* — rejected as a bad trade for one user with two devices. It
  would cost reliable web push, would require a full replica on whichever device
  is answering a statistics query, and would add a sync protocol to debug across
  unreliable mobile networks.

A direct consequence: **clearing browser site data wipes only the local cache.**
The server holds the canonical copy. Offline means cached reads plus a write
outbox, not full offline-first operation — which is the right call for a
statistics application that needs a canonical view.

API access from off the machine additionally requires the pairing bearer
token (`TAKALIF_TOKEN` or the persisted sidecar file); loopback callers never
need it, and `/api/health` stays open for managers and probes. The pairing
endpoint itself answers loopback callers only. The companion keeps its token
in device storage: whoever holds it holds the ledger, which is exactly what
the bearer is for — there is no milder credential to offer.

---

## 4. The materialisation step

Every endpoint that reads or writes the ledger runs the generator first.

```
request ──▶ middleware ──▶ generatePlan(state, now) ──▶ apply in one transaction
                                       │
                                       ▼
                                 response
```

The generator is a pure function over committed state and an injected clock. It
returns a plan; it touches nothing.

```
generatePlan({ settings, rules, versions, skipPeriods, exceptions, occurrences, now })
  → { today, window, toInsert, toUpdate, toDelete, sweep, recovered,
      recoveryPrompt, failedRules }
```

The caller applies the plan atomically. A reader therefore never observes a
half-materialised window.

**Why run it on every request?** It is a pure function over a bounded window —
roughly 45 days of occurrences. That is sub-millisecond, and idempotent, so
re-running does no work. The alternative — a cron job materialising the future —
would need a scheduler, a place to run it, and a story for a server that was down.
Lazy materialisation has none of those problems.

---

## 5. Why the recurrence library is behind a seam

`core/src/rrule.ts` is the **only** file that imports an RRULE library. Every
other module calls `expandRRule`, a plain function:

```ts
type RRuleExpander = (options: {
  rrule: string; dtstart: LocalDate; from: LocalDate; to: LocalDate;
}) => LocalDate[];
```

This matters because the best RRULE implementations are libraries with their own
opinions about date handling. Putting them behind one function means:

- swapping implementations is a one-file change;
- the generator can be tested without depending on library behaviour;
- the calendar extension in `calendars.md` is an adapter concern, not something
  smeared through the domain.

---

## 6. Timezone model

The timezone is **server-side state**, never read from the device.

Reason: two devices in two zones would otherwise disagree about what "today" is,
and the ledger would fork. The device may *propose* a change; the server stores
it.

Day boundaries are then resolved in that zone. See [data model](data-model.md)
for the rollover.

---

## 7. Consistency and concurrency

Single user, single server, SQLite in WAL mode.

- The generator runs inside the same transaction that applies its output, so a
  reader never sees a partial window.
- WAL lets a read (the statistics query) proceed while a write (a check-off) is
  in flight.
- `busy_timeout` covers the rare contention between a browser tab and a push
  worker writing at the same moment.

There is no distributed consistency problem to solve, because there is only one
writer. That is one of the reasons the architecture is this simple.

---

## 8. Deployment

### Docker

```bash
docker compose up -d --build
```

The compose file builds the image, maps port 8787, and keeps the ledger in a
named volume — SQLite WAL mode needs a POSIX filesystem, which Windows/Mac
bind mounts do not provide. `HOST` must be `0.0.0.0` inside the container — the
server default binds loopback, which is unreachable from outside — and the
compose file sets it. See [ADR 0008](adr/0008-container-packaging.md) for the
image decisions.

or from source:

```bash
pnpm install
pnpm build
pnpm --filter @takalif/server start
```

The server serves both the API and the built PWA from a single process. There is
no separate frontend host, no reverse proxy requirement, and no external
database.

Configuration is environment variables only; see the [README](../README.md#configuration).

### Desktop app (Windows)

```bash
pnpm build
pnpm --filter @takalif/desktop fetch-sidecar
pnpm --filter @takalif/desktop bundle
```

produces NSIS and MSI installers. The Tauri window loads the sidecar-served
PWA over loopback, so the webview is same-origin and no web code changes;
the sidecar is a stock Node runtime plus the server bundle and its native
closure, with data in `%APPDATA%`. See `packages/desktop/README.md` for the
layout and the dev loop.
