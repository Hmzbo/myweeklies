# ADR 0019 — Offline companion: read cache plus an outbox, server still the truth

**Status:** Accepted (2026-10-10)

---

## Context

The server is the source of truth (ADR 0006), which made one consequence
unavoidable: with the PC off, the phone shows nothing. That is acceptable for a
web app and unacceptable for a phone app — the exact moment you want to check
off a workout is often the moment the desktop is still asleep. Real usage turned
the accepted negative into a blocker.

Ship target: v0.1.0. The "clearing site data is harmless" clause of ADR 0006 is
**superseded in one respect** below.

---

## Decision

**Clients gain a replica: a bounded read cache plus a durable outbox. The
server remains the only writer of truth.**

1. **Read cache.** Every fetched `/api/day` (and range view) response is kept,
   bounded by count — least-recently-fetched slots evicted, capped so the
   browser's storage quota never enters the picture. Offline, the UI renders
   from the cache and says so honestly with a banner naming the staleness.
2. **Outbox.** Only actions whose *only* server-side guard is "the day is open"
   may queue offline: changing an occurrence's status (`done`, `missed`,
   `skipped`). The queue is persisted immediately, applied optimistically to
   the cached day, and replayed in order when the server returns. Rule
   creation, schedule edits, skip periods and settings stay online-only — they
   carry domain logic the client must not reimplement.
3. **Replay = the existing endpoints, one POST each.** No client-side
   reconciliation logic; the server's own rules arbitrate every queued change:

   | Replay outcome | Meaning | Client action |
   |---|---|---|
   | `200` | Applied | Mark the slot confirmed |
   | `4xx` — day closed (`missed` by the sweep) | The offline tap happened after the server gave up on that day | Surface "kept as missed"; offer the existing **excuse** exit, never auto-mutate a settled row (§ of ADR 0001) |
   | `4xx` — occurrence gone | Rule archived while away | Drop the item, note it in the banner |
   | `401` | Pairing was rotated while away | Stop replaying, prompt re-pairing (existing Connect flow) |

4. **Sync triggers:** browser `online` event, a visibility change, and a slow
   health-probe retry while the outbox is non-empty. Not a background daemon —
   the app replays when it is opened or woken, which is when the user is
   looking at it.

No new domain code in `packages/core`: the troublesome questions (what is
settled, when does a day close, what counts) are already named there and
enforced server-side. The client only persists intent and shows outcomes.

---

## Consequences

**Positive**

- Check-off works with the PC off — the phonepickup case loses its failure mode.
- No conflict resolution to write: single user + terminal-state invariants +
  server arbitrating = the three real conflict shapes above.
- Benefits every client for free (PWA, companion, desktop webview all share the
  same code path).

**Negative — accepted**

- **Clearing browser site data now also loses queued (unsynced) changes.**
  ADR 0006 called such a wipe harmless because the server held the canonical
  copy; with an outbox that is no longer fully true. The exposure window is the
  offline period itself, bounded by the outbox cap, and the companion's
  localStorage survives restarts. Accepted, and stated in the UI when edits are
  pending.
- Statistics views degrade to cached or skeleton while offline. Only Today is
  fully functional.
- A queued tap can end up "kept as missed" if the day closed while away — the
  existing excuse flow is the deliberate exit, consistent with the invariant
  that automation never rewrites settled rows.

---

## Alternatives considered

### Full offline-first (local SQLite/IndexedDB replica of the ledger, background merge)

- **Against:** reintroduces the very complexity the server removed (see ADR
  0006's mesh rejection) for a single-user, two-device product. The generator's
  idempotent reconciliation running server-side on replay covers everything the
  conflicts are about anyway.

### CRDT / sync engine (Automerge, Yjs)

- **Against:** the workload is not collaborative text; it is status flips on an
  append-only ledger with an arbiter available. A CRDT would be machinery
  without a problem, and its eventual consistency would fight the "settled rows
  are frozen" semantics.

### Store-and-forward with client-side conflict resolution

- **Against:** whoever "resolves" a closed day client-side has to know how the
  generator sweeps — a second implementation of core logic in the client,
  which cannot be exhaustively tested the way the pure core is.

### Do nothing (status quo)

- **Against:** real blocker. The first missed morning with the PC down kills
  the ledger's promise; the ledger is the product.
