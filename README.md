<p align="center">
  <img src="packages/web/public/icon.svg" alt="Takalif logo" width="120">
</p>

<h1 align="center">Takalif</h1>

<p align="center">
  <strong>Track recurring commitments, and see how faithfully you actually kept them.</strong>
</p>

<p align="center">
  <a href="https://github.com/Hmzbo/takalif/actions/workflows/ci.yml"><img src="https://github.com/Hmzbo/takalif/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white" alt="Windows x64">
</p>

Most habit trackers ask "did you do the thing today?" and give you a streak.
Most to-do apps ask "what did you plan?" and then forget the answer. Neither one
can tell you how often you kept a promise you made to yourself in February.

Takalif is a small, self-hosted app for **recurring commitments** — daily,
weekly, monthly — and the **adherence record** you build up over time.

```
September 2026 · 20 / 30        66.7% adherence
10 missed · 2 skipped
```

---

## What makes it different

Most recurring-task apps model recurrence as *"clone the next occurrence when
you mark this one done"*, which means the past does not exist. You cannot
compute compliance over data that no longer exists.

Most habit trackers solve the opposite problem — they do have history — but their
schedules are **quotas** ("3x per week"), not **calendars**. A quota cannot
express "every second Tuesday" or "the last Friday of the month", and because
everything is bucketed into day cells, "did I do the monthly review on time?"
collapses into "was the September box green?"

Takalif keeps the two things separate:

- **The schedule** — real recurrence. Every second Tuesday, the 1st of the
  month, weekdays only, the last Friday.
- **The ledger** — every *expected* occurrence, recorded, kept for years.

Because the expected set is real data rather than a guess reconstructed from what
you happened to log, the statistics are actually correct.

### And editing a schedule does not rewrite your history

Loosen "Workout" from daily to three times a week, and your past adherence stays
exactly where it was. Schedules are versioned; settled entries keep pointing at
the version that produced them.

This is not a detail most apps get right — it is structurally impossible for
them to get right, because their data model cannot express it.

---

## What you get

- **Today, Calendar, Stats.** Check off what's due, browse the week or month
  and jump to any day, and watch adherence over trailing weeks, months and years.
- **Real recurrence.** Every second Tuesday, the 31st (skipped in February, never
  clamped), weekdays only, Hijri-month anchors.
- **Honest holidays.** Mark a date range as away. Those days leave the
  denominator — but if you train anyway, it still counts as a success.
- **Streaks, if you want them.** Opt-in per task, off by default.
- **No backlog graveyard.** Come back after three weeks and you get a prompt
  offering to mark the gap missed or skipped, rather than a wall of silent
  failures.
- **Evening-friendly.** A day closes at a configurable rollover time (default
  4:00 AM), so a task done at 11 PM is not a failure.
- **Timezone-correct.** Your timezone is stored server-side, so your phone and
  your laptop always agree on what "today" is.
- **Notes on any day.** A line of context that never touches the figures.
- **Phone and desktop.** Installable app on Android, tabs on the phone and a
  sidebar on a wide screen.
- **Export your data.** JSON backup and restore, CSV ledger, CalDAV `VTODO`
  schedules — your history outlives this app.

---

## Quick start

### Docker

```bash
git clone https://github.com/Hmzbo/takalif.git
cd takalif
docker compose up -d --build
```

Open <http://localhost:8787>. The ledger lives in a named volume and survives
image rebuilds; take JSON backups from Settings → Data.

### Desktop app (Windows)

The one-click install — no Docker, no terminal. Download
`Takalif_0.1.0_x64-setup.exe` from the
[releases page](https://github.com/Hmzbo/takalif/releases) and run it.

It bundles the same server and interface: your data lives in
`%APPDATA%/com.takalif.desktop/takalif.sqlite`, and backups from Settings →
Data move freely between the app, Docker, and source installs. The first
window can take a few seconds while the bundled server starts; if it ever
greets you with an error instead, wait a moment and press Retry.

### From source

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm build
pnpm --filter @takalif/server start
```

The database is a single SQLite file. There is nothing else to configure, and no
account to create.

### Try it with sample data

```bash
pnpm --filter @takalif/server seed
```

writes `data/demo-ledger.json` — about three months of plausible history:
seven rules (daily, weekdays, monthly, one Hijri, one archived), streaks,
notes, and a week away that leaves the adherence denominator. Import it in
the app under **Settings → Data → Restore from backup** and every screen
(Today, Calendar, Stats) has something to show.

**Restore replaces everything on the server.** Do this on a scratch instance
if you have real data — or export a backup of your own first and keep it safe.
To explore without touching your instance at all:

```bash
docker run -d --name takalif-demo -p 8788:8787 -e HOST=0.0.0.0 takalif:latest
```

then open <http://localhost:8788> and import there. Remove it with
`docker rm -f takalif-demo`.

---

## Using it on your phone

Open the server's URL in Chrome and choose **Install app** (or **Add to Home
screen**). It appears in your app drawer and launches fullscreen with no browser
chrome. On desktop, Chrome and Edge both offer **Install this site as an app**,
which adds a Start Menu entry.

### Reaching it from your phone on the same network

Use `http://<your-PCs-LAN-address>:8787` — `localhost` on the phone means the
phone itself. The compose setup already listens on all interfaces; from source,
start with `HOST=0.0.0.0`.

### If the site can't be reached

1. Phone and PC on the **same WiFi** (no guest network, no VPN on either side).
2. Find the PC's LAN address (`ipconfig` on Windows, look for IPv4) and open
   `http://THAT-IP:8787` from the PC first. If the PC can't open it either, the
   server isn't up.
3. **Windows firewall** must allow inbound TCP on the companion ports
   (8787–8788). The desktop app adds the rule for you: Settings → Pair a
   device → **Allow phones through the firewall** (one press, and only with
   your permission). Docker usually prompts on first `compose up`; otherwise
   add the rule by hand.
4. For access from anywhere (not just home), put it behind Tailscale or any
   reverse proxy you already trust — and put authentication in front, since the
   server itself has none.

---

## Configuration

Everything is optional; the defaults work.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in compose) | Bind address. Loopback is unreachable from other machines |
| `DB_FILE` | `./data/takalif.sqlite` (`/data/takalif.sqlite` in compose) | SQLite database location |
| `WEB_DIST` | `./packages/web/dist` | Built PWA to serve, when present |
| `VAPID_PUBLIC_KEY` | — | Web-push public key. Without both keys, push stays disabled |
| `VAPID_PRIVATE_KEY` | — | Web-push private key. Generate a pair, keep this secret |
| `VAPID_SUBJECT` | `mailto:takalif@localhost` | Contact URN attached to push requests |
| `ALLOWED_ORIGINS` | — | Extra browser origins allowed to call the API |
| `TAKALIF_TOKEN` | auto-generated | Bearer token required on LAN API calls (loopback never needs it). Without it, a `takalif.token` file next to the database persists the generated value. Pinned mode disables rotation: unset it to rotate |

The server is single-user by design: no accounts, no user table. If you expose it
beyond your own machine, put it behind a reverse proxy that handles
authentication.

---

## Reminders

Set a reminder time on any task and the server notifies you on days it is due.
The check runs once a minute, server-side, so it works whether or not any
client is open. Each occurrence is reminded at most once.

Two delivery channels, either or both:

1. **Web push.** Generate a key pair once and set the env vars above:
   ```bash
   npx web-push generate-vapid-keys
   ```
   Then open Settings → Notifications → **Enable on this device**, and use
   **Send test** to confirm the whole path works before trusting it.
2. **ntfy fallback.** Set an ntfy topic in Settings (and optionally your own
   server instead of ntfy.sh), subscribe to the topic in the ntfy app, and
   reminders arrive there too — no account, no per-device setup. On the public
   server, pick an unguessable topic name: anyone who knows it can read it.

Dead push subscriptions (reported gone by the push service) are pruned
automatically.

---

## How adherence is calculated

```
adherence = done / (done + missed)
```

- **Skipped days are excluded from the denominator.** A holiday should not count
  as failure.
- **Completing a skipped day still counts as a success.** Train on your holiday
  and it moves to `done`.
- **Pending days are excluded**, so an unfinished day never counts against you.
- With nothing elapsed, adherence is reported as `—`, never `0%`.

Streaks, when enabled for a task: `done` extends the run, `missed` breaks it,
`skipped` is neutral, and pending days are not yet terminal.

---

## Project status

Usable and in active development. Shipped: the domain core (ledger, generator,
statistics), the HTTP API with SQLite persistence, the PWA (today, calendar,
tasks, stats, settings), server-side reminders (web push with ntfy fallback),
export/backup (JSON restore, CSV ledger, VTODO schedules), Docker packaging,
a Windows desktop app (Tauri shell + bundled server), and LAN pairing auth.

Still ahead: the QR pairing screen, the Android companion, releases and
versioning, multi-arch images, and wider platform testing.

Built as a personal tool first, released openly in the hope it is useful to
someone else.

---

## Documentation

Full technical documentation for engineers, including the architecture, the data
model, and the reasoning behind each decision:

- [`docs/overview.md`](docs/overview.md) — the idea, and what it deliberately is not
- [`docs/requirements.md`](docs/requirements.md) — functional and non-functional requirements
- [`docs/features.md`](docs/features.md) — feature-level behaviour
- [`docs/architecture.md`](docs/architecture.md) — the system and the client/server split
- [`docs/data-model.md`](docs/data-model.md) — schema and the invariants that protect your data
- [`docs/statistics.md`](docs/statistics.md) — the adherence formulas, worked through
- [`docs/calendars.md`](docs/calendars.md) — recurrence and Gregorian + Hijri support
- [`docs/adr/`](docs/adr/index.md) — architecture decision records

---

## Contributing

Contributions are welcome, including recurrence edge cases and confusing
statistics — those reports are as valuable as patches.

**Read [`Agents.md`](Agents.md) first**, then `pnpm test` and `pnpm typecheck`
before opening a PR against `main`. Out of scope by design: one-off tasks,
meetings, quotas, default streaks, and anything rewriting settled history.

---

## Licence

MIT. See [LICENSE](LICENSE).
