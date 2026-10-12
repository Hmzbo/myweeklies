# Agents.md

Guidance for humans and AI agents working in this repository.

Read this before writing code. It describes how the project is structured, the
invariants that must hold, and the git workflow we require.

---

## 1. What this project is

Takalif tracks **recurring commitments** — daily, weekly, monthly — and
measures how faithfully they were kept over time.

Two distinct objects:

- **The rule**: a calendar-grade recurrence ("every 2nd Tuesday", "the 1st of
  the month"), stored as RFC 5545 RRULE.
- **The ledger**: a material record of every *expected* occurrence, each ending
  `done` / `missed` / `skipped`, retained indefinitely.

The check-off is trivial. The product is the expected-vs-actual ledger and the
statistics over it.

**Scope boundaries are deliberate.** This is not a calendar, not a to-do app,
and not a quota-based habit tracker. See `docs/adr/` for the full rationale.

---

## 2. Repository layout

```
packages/
  core/     Pure domain. No I/O, no framework, no database.
            - dates.ts       calendar-date arithmetic, timezone helpers
            - rrule.ts       the ONLY file that imports an RRULE library
            - types.ts       domain types and the status model
            - generator.ts   the occurrence planner
            - applyPlan.ts   pure plan application, used by tests
            - stats.ts       adherence, streaks, trends, reports
  server/   Fastify + SQLite. HTTP API and persistence.
            - db.ts          connection + schema bootstrap
            - repo.ts        all SQL lives here
            - app.ts         routes
  web/      PWA client (React + Vite)
docs/
  adr/      Architecture decision records
```

`packages/core` is pure **by design**. This is what makes the generator and the
statistics exhaustively testable without a database, and it is the most
important structural constraint in the repository.

---

## 3. Setup

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm test          # all packages
pnpm typecheck
pnpm --filter @takalif/core test
pnpm --filter @takalif/server start
```

`better-sqlite3` and `esbuild` need native build steps. These are allowlisted in
`pnpm-workspace.yaml` under `allowBuilds`; if you ever see
`ERR_PNPM_IGNORED_BUILDS`, that block was removed or a dependency was added that
needs approving.

---

## 4. Domain invariants

These are not style preferences. Breaking any of them silently corrupts user
data. Every one is covered by a test in `packages/core/test/generator.test.ts`.

### 4.1 A `LocalDate` is a `YYYY-MM-DD` string

Never a `Date`, never a UTC instant. All calendar arithmetic runs on
UTC-midnight `Date` objects used purely as an integer carrier, so that daylight
saving transitions cannot shift an occurrence by a day. Use the helpers in
`dates.ts`; do not do date math by hand.

### 4.2 Terminal states are frozen against automation

`done`, `missed` and `skipped` are **never** rewritten by the generator.
`pending` is the only state automation may change. Explicit user actions may
reassign an occurrence between statuses, but only while its day is still open;
after the day closes the rows are locked, with excusing a `missed` day as the
one deliberate exit.

If a change would require mutating a settled occurrence automatically, the
change is wrong.

### 4.3 Nothing exists before `rules.created_date`

You cannot have failed at a commitment you were not yet tracking. Backdating is
possible deliberately, by moving `dtstart_date`.

### 4.4 Editing a schedule never rewrites history

Every edit opens a new `rule_versions` row with an `effective_from` date.
Occurrences record the `rule_version` that produced them, so historical rows are
never reinterpreted.

The test that guards this is "does not reinterpret past occurrences when the
schedule is loosened". If you touch reconciliation logic, that test must still
pass.

### 4.5 A day closes at the rollover time, not at midnight

The occurrence for date `D` stays open until `D+1` at `settings.day_rollover`
(default `04:00`) in the user's timezone. Sweeping at local midnight would mark
every task done after dinner as failed.

### 4.6 Timezone is server-side state

Never read the timezone from the device. Two devices in two zones would
otherwise disagree about what "today" is, and the ledger would fork.

---

## 5. Where logic belongs

- **All SQL goes in `packages/server/src/repo.ts`.** Routes in `app.ts` call
  repository functions; they do not contain queries.
- **All recurrence expansion goes through `expandRRule` in `core/src/rrule.ts`.**
  Nothing else may import `rrule` directly. That boundary is what makes the
  library replaceable — swapping to a Temporal-based implementation should be a
  one-file change.
- **All schedule/statistics logic belongs in `packages/core`.** If you find
  yourself writing date logic in a route or component, it belongs in core with a
  test.

---

## 6. Testing expectations

- `packages/core` is pure, so tests are table-driven and cheap. **New recurrence
  or statistics behaviour needs a golden test**, not a smoke test.
- Use a **fixed injected clock** (`helpers.ts` exports `NOW`). Never assert
  against the real current date.
- Timezone-sensitive tests must assert that behaviour is *invariant* to the host
  machine's zone, not merely correct in the developer's zone.
- The server needs integration tests against an in-memory SQLite database for
  anything touching persistence.

Run `pnpm test` before opening a PR. A PR with failing tests will not be
reviewed.

---

## 7. Git workflow

**`main` is protected. Never commit or push directly to it.**

### Branch naming

```
<type>/<short-description>
```

`type` is one of:

| Type | Use for |
|---|---|
| `feat` | New user-visible capability |
| `fix` | Bug fix |
| `refactor` | Behaviour-preserving internal change |
| `test` | Tests only |
| `docs` | Documentation only |
| |  |
| `build` | Build system, dependencies, tooling |
| `ci` | Pipelines and automation |
| |  |
| `chore` | Maintenance that fits nowhere else |

Use `core/`, `server/` or `web/` as a namespace when the change is scoped to one
package:

```
feat/core/skip-periods
fix/server/occurrence-reset
docs/adr-lazy-materialization
```

Keep the branch focused on one logical change. A branch that fixes the
generator *and* restyles the UI should be two branches and two PRs.

### Flow

1. Branch off `main`, keeping it up to date:
   ```bash
   git checkout main
   git pull --ff-only
   git checkout -b feat/core/thing
   ```
2. Commit in small, logical units.
3. Push the branch:
   ```bash
   git push -u origin <branch-name>
   ```
4. Open a **pull request targeting `main`**. Never push to `main`.
5. Wait for review and CI. Address feedback with new commits on the same branch.
   Do not force-push over someone else's review context unless asked — prefer
   `git rebase` locally or merge `main` into your branch.

### Commit messages

Conventional Commits:

```
<type>(<scope>): <subject>

<optional body explaining why, not what>
```

- Subject in the imperative mood, lowercase, no trailing period.
- Scope is optional; use the package name when relevant.
- Explain **why** in the body. The diff already shows what changed.

```
fix(core): freeze skipped occurrences inside a newly added skip period

Creating a skip period retroactively rewrote already-completed rows,
because reconciliation re-evaluated every pending date without checking
the skip periods. Terminal rows are now left alone.

fix(server): guard reset against non-pending occurrences

POST /reset returned 200 for an occurrence that was already settled,
which let clients silently resurrect history.
```

### PR descriptions

The repository is public. Everything you write — PR title, PR body, review
comments, commit messages, UI strings, README — ships to the internet, so a
PR description is written once, for two audiences at once: the reviewer who
needs the reasoning, and a stranger who must never learn anything about the
maintainer's machine.

**Write:**

1. **Open with the user-visible problem and the *why*** — not the diff.
   The diff shows what; the body explains the reason the change exists and
   the reasoning that does not fit in the subject line.
2. **Name the invariant story:** which domain invariants (`§4`) were touched
   or considered, and why none was violated — explicitly, when the change
   even *seems* to require bending one.
3. **State the verification:** which suites ran and what they may miss
   (e.g. "device-tested by the maintainer", or "verified by construction
   only" — said plainly, never implied).
4. **If it stacks, say so:** which PRs must merge first and why. Stacked
   branches are the ordinary workflow, not a surprise.
5. End short. A long body that buries the invariant note is worse than a
   short one that carries it.

**Never put in a PR — or anywhere public:**

| Banned | Placeholder instead |
|---|---|
| Real LAN or public IP addresses, hostnames, WiFi/SSID names | `<PC-IP>`, or the generic example `192.168.1.10:8787` |
| Pairing tokens, bearer tokens, secrets, key material | `<token>` |
| Absolute paths from the maintainer machine (`D:\Work\…`, `%APPDATA%\…`) | Paths relative to the repo root (`packages/web/src/…`) |
| Usernames, email, device names, screenshot contents | — just don't include them |
| Error banners quoted raw — they embed real addresses. **Paraphrase.** | `a 'Cannot reach <server>' error` |
| Any live ledger content or personal data, even as an example | Use the seed fixture (`pnpm --filter @takalif/server seed`) data when an example helps |

**Before posting, reread the body asking one question:** 'Could someone who
has never met me learn something private from this?' — if any word answers
yes, replace that word with its placeholder and post the rule's way.

**If something leaked anyway:** redact the artifact immediately
(`gh pr edit --body-file`), fix the tree with a follow-up commit, assess the
blast radius honestly (token/key material ⇒ force rotation *and* consider a
history rewrite; RFC 1918 addresses prior to redaction ⇒ document, do not
rewrite history over it), and record the lesson in the session handoff.

### Squash or rebase?

Squash-merge is preferred, so `main` carries one commit per PR. Write commits
as if they will be squashed, because they may be — the PR description carries
the reasoning that does not fit in a single line.

---

## 8. Pull request checklist

- [ ] Branch is not `main`, and follows the naming convention
- [ ] `pnpm test` and `pnpm typecheck` pass
- [ ] New behaviour in `packages/core` has tests, including any new edge case
      you discovered while writing them
- [ ] Tests use an injected clock, not the real date
- [ ] No domain invariants (§4) were violated — call this out explicitly in the
      PR description if a change seems to require it
- [ ] Schema changes include a migration path and are noted in the PR
- [ ] No secrets, no `.env`, no committed database files
- [ ] PR description explains the *reason* for the change
- [ ] PR description (title, body, and any comments) contains no internal
      identifiers — addresses, tokens, machine paths, user data; §7's rules
      and placeholders are followed
- [ ] The change is public-safe everywhere: UI strings, README and commit
      messages carry no maintainer-machine context either

---

## 9. Things that will get a PR declined

- **A generic to-do feature.** One-off tasks, due dates without recurrence,
  subtasks, priorities as scheduling. Out of scope by design.
- **Streaks or gamification by default.** Streaks are opt-in per rule; the
  headline metric is adherence.
- **A quota model** ("3x per week"). This project models *schedules*. Quotas
  are a different product, and adopting one breaks the semantics of the ledger.
- **Terminal-state mutation.** See §4.2.
- **Timezone read from the device.** See §4.6.
- **A second RRULE library used anywhere but `rrule.ts`.**
- **Scope creep on multi-user, auth, or sharing** without agreeing on it first.

---

## 10. Decisions

`docs/adr/` records the reasoning behind each architectural choice. Before
changing something structural — the data model, the materialization strategy,
the status set, the client/server split — read the relevant ADR and open a PR
that supersedes it rather than editing history.

`Plan.md` is the maintainer's local roadmap. It is gitignored and not part of
the project's public documentation.