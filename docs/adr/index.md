# Architecture Decision Records

Reasoned records of the decisions that shape this project. Written because the
*why* matters more than the *what* — the code shows what was done, but only a
record explains what was considered and rejected.

Read these before changing anything structural.

| ADR | Decision |
|---|---|
| [0001](0001-lazy-materialization-and-versioned-schedules.md) | Lazy materialization + versioned schedules |
| [0002](0002-civil-dates-not-utc-instants.md) | Civil dates, not UTC instants |
| [0003](0003-day-rollover.md) | A day closes at a rollover time, not midnight |
| [0004](0004-skip-periods.md) | Skip periods as ranges, excluded from adherence |
| [0005](0005-multi-calendar-support.md) | Per-rule calendars: Gregorian and Hijri |
| [0006](0006-pwa-and-self-hosted-server.md) | PWA client, self-hosted server as source of truth |
| [0007](0007-data-portability.md) | JSON backup/restore, CSV and VTODO export |
| [0008](0008-container-packaging.md) | One image, one process, one volume |
| [0019](0019-offline-companion.md) | Offline companion: read cache + outbox, server still the truth |

## Conventions

Each ADR records **context**, **decision**, **consequences** and **alternatives
considered**. The alternatives section matters most: a decision that records no
rejected option is usually an assertion, not a decision.

## Changing a decision

Do not edit an accepted ADR. Write a new one that supersedes it, link back, and
update the index. Decisions are history, and history that can be quietly
rewritten is not a record.
