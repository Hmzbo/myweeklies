import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  addDays,
  daysBetween,
  GREGORIAN,
  isKnownCalendar,
  isValidDate,
  isValidTime,
  ledgerToCsv,
  rulesToVCalendar,
  toHijri,
  todayInTimeZone,
  validateRRule,
  type CalendarKind,
  type Occurrence,
  type Rule,
  type Settings,
} from '@takalif/core';
import type { DB } from './db.js';
import { bearerToken, isLoopback, lanIPv4, pickPairingInterfaces, rotateToken } from './auth.js';
import { networkInterfaces } from 'node:os';

/**
 * WebView origins of the native companion shells (Android `http`, iOS
 * `capacitor` scheme). Allowed by construction, never by user config: a
 * browser always reports its true Origin, so no remote site can borrow these,
 * and only a local companion process can own them.
 */
const NATIVE_ORIGINS = ['capacitor://localhost', 'http://localhost'];
import {
  archiveRule,
  buildPeriodReport,
  bulkExcuseOccurrences,
  changeOccurrenceStatus,
  createRule,
  createSkipPeriod,
  deleteSubscription,
  deleteSkipPeriod,
  excuseOccurrence,
  isOccurrenceElapsed,
  listSubscriptions,
  materialize,
  previewRuleEdit,
  readAllForBackup,
  readLedgerRows,
  readOccurrence,
  readOccurrences,
  readRules,
  readSettings,
  readSkipPeriods,
  resetOccurrence,
  restoreBackup,
  saveSubscription,
  setOccurrenceNote,
  setOccurrenceStatus,
  updateRule,
  updateSettings,
  type UpdateRuleInput,
} from './repo.js';
import {
  pushConfigured,
  sendTestNotification,
  type PushConfig,
} from './reminders.js';

/** Default clock: wall time. Tests inject a fixed one. */
const wallClock = (): Date => new Date();



/** Widest range any report will accept, matching the `year` preset. */
const MAX_REPORT_SPAN_DAYS = 3660;

/** Cap on user-supplied free text. */
const MAX_TEXT = 500;

/**
 * Resolve a requested calendar against the user's default.
 *
 * Absent means "use my default", so a new rule inherits the preference. An
 * unsupported value is rejected rather than silently downgraded.
 */
function resolveCalendar(value: unknown, fallback: CalendarKind): CalendarKind {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !isKnownCalendar(value)) {
    throw new Error(`Unsupported calendar: ${String(value)}`);
  }
  return value;
}

export interface BuildAppOptions {
  /**
   * Origins permitted to call the API from a browser.
   *
   * Empty (the default) means same-origin only. Reflecting any origin was the
   * single most dangerous thing in the previous revision: the server binds
   * loopback, but it is the *browser* that makes the request, so `origin: true`
   * let any site the owner visited read and rewrite their whole ledger.
   */
  allowedOrigins?: string[];
  logger?: boolean;
  /**
   * Injectable clock.
   *
   * Integration tests must never assert against the real current date: the
   * materialisation window is relative to today, so a test whose expectations
   * name specific dates would pass today and fail tomorrow. Defaults to wall
   * clock.
   */
  now?: () => Date;
  /**
   * Web-push credentials, read from VAPID_* env vars by index.ts. Absent means
   * push delivery is disabled; the subscribe and test routes answer 503 rather
   * than accepting subscriptions that can never fire.
   */
  push?: PushConfig;
  /**
   * LAN pairing token. Loopback callers never need it — only this machine can
   * reach loopback. Non-loopback callers must present it as a bearer token on
   * every /api route except /api/health, because opening the bind to the LAN
   * would otherwise expose the whole ledger to the Wi-Fi. `tokenDir` is where
   * the token file lives, so rotation can persist it; `pinned` means the value
   * came from the environment, in which case rotation is refused rather than
   * silently undone on the next boot.
   */
  auth?: { token: string; tokenDir?: string; pinned?: boolean };
}

export function buildApp(db: DB, options: BuildAppOptions = {}): FastifyInstance {
  if (options.auth && !options.auth.token) {
    // An explicitly empty token would silently disable enforcement.
    throw new Error('auth.token must be a non-empty string');
  }
  const app = Fastify({ logger: options.logger ?? true });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const clock = options.now ?? wallClock;
  // Reassignable: rotation replaces the accepted token in place.
  let authToken = options.auth?.token;
  const authDir = options.auth?.tokenDir;
  const authPinned = options.auth?.pinned ?? false;

  /**
   * Same-origin requests send no `Origin` header at all (curl, the bundled PWA
   * served from this process, native app shells). Those are allowed. A browser
   * cross-origin request must name an explicitly allowed origin.
   */
  app.register(cors, {
    origin(origin, callback) {
      // Same-origin requests, curl and native app shells send no Origin.
      // Absent that, explicitly allowed origins plus the companion WebView
      // origins may call us: reflecting any other origin would let any site
      // the owner visits read and rewrite the ledger, because it is the
      // browser that makes the request.
      if (origin === undefined || allowedOrigins.has(origin) || NATIVE_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      // Refuse without an error: an Error here reaches setErrorHandler and
      // turns a rejected cross-origin request into a 500, which is both noisy
      // and indistinguishable from a genuine server fault.
      callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  /**
   * Do not leak internal error text. Fastify's default serializer returns the
   * raw exception message, which for better-sqlite3 means table and column
   * names, and for a bad date means the JS error. Useful to nobody, and a
   * reconnaissance aid.
   */
  app.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      reply.code(status).send({ error: 'Internal Server Error' });
      return;
    }
    reply.code(status).send({ error: err.message ?? 'Request failed' });
  });

  /**
   * Every endpoint that reads or writes the ledger runs the generator first, so
   * a response is never stale with respect to the current time or the current
   * schedule. It is cheap (pure function over a bounded window) and idempotent.
   */
  const sync = () => materialize(db, clock());

  /** Return an error body *with* a real status code. */
  const fail = (reply: FastifyReply, status: number, message: string) =>
    reply.code(status).send({ error: message });

  const badRequest = (reply: FastifyReply, message: string) => fail(reply, 400, message);
  const notFound = (reply: FastifyReply, message: string) => fail(reply, 404, message);
  const conflict = (reply: FastifyReply, message: string) => fail(reply, 409, message);

  /** Fastify parses duplicate query keys into arrays; coerce to a single string. */
  const single = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    return typeof value === 'string' ? value : undefined;
  };

  const body = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  /**
   * Validate an optional free-text field.
   *
   * Returns a result object rather than `undefined` on failure, because a
   * handler that returns `reply` to signal "already answered" leaves Fastify
   * with a non-serialisable return value — which hung the route outright.
   */
  const optionalText = (
    value: unknown,
    field: string,
  ): { ok: true; value: string | null } | { ok: false; error: string } => {
    if (value === undefined) return { ok: true, value: null };
    if (value === null) return { ok: true, value: null };
    if (typeof value !== 'string') {
      return { ok: false, error: `${field} must be a string` };
    }
    if (value.length > MAX_TEXT) {
      return { ok: false, error: `${field} must be at most ${MAX_TEXT} characters` };
    }
    return { ok: true, value };
  };

  // -- settings -------------------------------------------------------------

  app.get('/api/settings', async () => readSettings(db));

  app.patch('/api/settings', async (req, reply) => {
    const input = body(req.body);

    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string') return badRequest(reply, 'timezone must be a string');
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone });
      } catch {
        return badRequest(reply, `Unknown IANA timezone: ${input.timezone}`);
      }
    }
    if (input.dayRollover !== undefined && !isValidTime(String(input.dayRollover))) {
      return badRequest(reply, 'dayRollover must be HH:MM');
    }
    if (input.defaultCalendar !== undefined) {
      if (typeof input.defaultCalendar !== 'string' || !isKnownCalendar(input.defaultCalendar)) {
        return badRequest(reply, `Unsupported calendar: ${String(input.defaultCalendar)}`);
      }
    }
    // Bounds matter more than they look: SQLite will store a string in an
    // INTEGER column, and an unbounded value makes every request materialise
    // an unbounded window.
    for (const field of ['lookbackDays', 'lookaheadDays'] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return badRequest(reply, `${field} must be a non-negative integer`);
      }
      if (value > MAX_REPORT_SPAN_DAYS) {
        return badRequest(reply, `${field} must be at most ${MAX_REPORT_SPAN_DAYS}`);
      }
    }
    if (input.email !== undefined && input.email !== null) {
      if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
        return badRequest(reply, 'email must be a valid address');
      }
    }
    if (input.ntfyTopic !== undefined && input.ntfyTopic !== null) {
      if (
        typeof input.ntfyTopic !== 'string' ||
        !/^[A-Za-z0-9_\-/]{1,64}$/.test(input.ntfyTopic)
      ) {
        return badRequest(
          reply,
          'ntfyTopic must be 1-64 characters of letters, numbers, -, _ or /',
        );
      }
    }
    if (input.ntfyServer !== undefined && input.ntfyServer !== null) {
      if (typeof input.ntfyServer !== 'string' || !/^https?:\/\/.{1,200}$/i.test(input.ntfyServer)) {
        return badRequest(reply, 'ntfyServer must be an http(s) URL');
      }
    }

    // Sync *after* the write. Syncing first meant a corrupt value made this
    // endpoint 500 before it could repair itself.
    const settings = updateSettings(db, input as Partial<Settings>);
    const plan = sync();
    return { ...settings, failedRules: plan.failedRules };
  });

  // -- rules ----------------------------------------------------------------

  app.get('/api/rules', async () => {
    const plan = sync();
    return { rules: readRules(db, true), failedRules: plan.failedRules };
  });

  app.post('/api/rules', async (req, reply) => {
    const input = body(req.body);
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const rrule = typeof input.rrule === 'string' ? input.rrule.trim() : '';
    if (!title) return badRequest(reply, 'title is required');
    if (title.length > MAX_TEXT) return badRequest(reply, `title must be at most ${MAX_TEXT} characters`);
    if (!rrule) return badRequest(reply, 'rrule is required');

    if (input.trackStreak !== undefined && typeof input.trackStreak !== 'boolean') {
      return badRequest(reply, 'trackStreak must be a boolean');
    }

    const description = optionalText(input.description, 'description');
    if (!description.ok) return badRequest(reply, description.error);
    const category = optionalText(input.category, 'category');
    if (!category.ok) return badRequest(reply, category.error);

    const settings = readSettings(db);
    const today = todayInTimeZone(settings.timezone, clock());
    const dtstartDate = single(input.dtstartDate) ?? today;
    const created = single(input.createdDate) ?? today;

    if (!isValidDate(dtstartDate)) return badRequest(reply, 'dtstartDate must be YYYY-MM-DD');
    if (!isValidDate(created)) return badRequest(reply, 'createdDate must be YYYY-MM-DD');
    if (!validateRRule(rrule, dtstartDate)) return badRequest(reply, `Invalid or unsupported RRULE: ${rrule}`);
    if (input.dueTime != null && !isValidTime(String(input.dueTime))) {
      return badRequest(reply, 'dueTime must be HH:MM');
    }
    if (
      input.reminderTime !== undefined &&
      input.reminderTime !== null &&
      input.reminderTime !== '' &&
      !isValidTime(String(input.reminderTime))
    ) {
      return badRequest(reply, 'reminderTime must be HH:MM');
    }

    // Validate the calendar before creating: an unsupported value is a bad
    // request, not a server fault.
    let calendar: CalendarKind;
    try {
      calendar = resolveCalendar(input.calendar, settings.defaultCalendar);
    } catch (error) {
      return badRequest(reply, (error as Error).message);
    }

    const rule = createRule(db, {
      title,
      description: description.value,
      rrule,
      dtstartDate,
      dueTime: input.dueTime == null ? null : String(input.dueTime),
      calendar,
      reminderTime:
        input.reminderTime === undefined || input.reminderTime === null || input.reminderTime === ''
          ? null
          : String(input.reminderTime),
      createdDate: created,
      trackStreak: input.trackStreak === true,
      category: category.value,
    });

    sync();
    return reply.code(201).send(rule);
  });

  app.patch('/api/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = body(req.body);
    const settings = readSettings(db);
    const today = todayInTimeZone(settings.timezone, clock());

    const effectiveFrom = single(input.effectiveFrom) ?? today;
    if (!isValidDate(effectiveFrom)) return badRequest(reply, 'effectiveFrom must be YYYY-MM-DD');

    // `dtstartDate` was previously unvalidated and the whole body was spread
    // into the update with an `as never` cast, which hid it.
    if (input.dtstartDate !== undefined) {
      const dtstartDate = single(input.dtstartDate);
      if (!dtstartDate || !isValidDate(dtstartDate)) {
        return badRequest(reply, 'dtstartDate must be YYYY-MM-DD');
      }
    }

    const rrule = single(input.rrule);
    if (rrule !== undefined && !validateRRule(rrule, effectiveFrom)) {
      return badRequest(reply, `Invalid or unsupported RRULE: ${rrule}`);
    }
    if (input.dueTime != null && !isValidTime(String(input.dueTime))) {
      return badRequest(reply, 'dueTime must be HH:MM');
    }
    if (
      input.reminderTime !== undefined &&
      input.reminderTime !== null &&
      input.reminderTime !== '' &&
      !isValidTime(String(input.reminderTime))
    ) {
      return badRequest(reply, 'reminderTime must be HH:MM');
    }
    if (input.trackStreak !== undefined && typeof input.trackStreak !== 'boolean') {
      return badRequest(reply, 'trackStreak must be a boolean');
    }
    const description = optionalText(input.description, 'description');
    if (!description.ok) return badRequest(reply, description.error);
    const category = optionalText(input.category, 'category');
    if (!category.ok) return badRequest(reply, category.error);

    // Explicit allowlist rather than a spread, so a future column cannot
    // silently become client-writable.
    const patch: UpdateRuleInput = { effectiveFrom };
    if (typeof input.title === 'string') patch.title = input.title.trim();
    if (input.description !== undefined) patch.description = description.value;
    if (input.category !== undefined) patch.category = category.value;
    if (rrule !== undefined) patch.rrule = rrule;
    const dtstartDate = single(input.dtstartDate);
    if (dtstartDate !== undefined) patch.dtstartDate = dtstartDate;
    if (input.dueTime !== undefined) {
      patch.dueTime = input.dueTime === null ? null : String(input.dueTime);
    }
    if (input.reminderTime !== undefined) {
      patch.reminderTime =
        input.reminderTime === null || input.reminderTime === ''
          ? null
          : String(input.reminderTime);
    }
    if (typeof input.trackStreak === 'boolean') patch.trackStreak = input.trackStreak;

    // Changing the calendar opens a new version: it reinterprets the anchors,
    // which is a schedule change in every sense that matters.
    const calendarValue = single(input.calendar);
    if (calendarValue !== undefined) {
      try {
        patch.calendar = resolveCalendar(calendarValue, readSettings(db).defaultCalendar);
      } catch (error) {
        return badRequest(reply, (error as Error).message);
      }
    }

    const rule = updateRule(db, id, patch);
    if (!rule) return notFound(reply, 'Rule not found');

    sync();
    return rule;
  });

  /**
   * Dry run for a schedule change: reports which unlogged occurrences the new
   * schedule would add or withdraw, so the user can see it before it happens.
   */
  app.get('/api/rules/:id/edit-preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = body(req.query);
    const rrule = single(q.rrule);
    const dtstartDate = single(q.dtstartDate);
    const settings = readSettings(db);
    const effectiveFrom = single(q.effectiveFrom) ?? todayInTimeZone(settings.timezone, clock());

    if (!isValidDate(effectiveFrom)) return badRequest(reply, 'effectiveFrom must be YYYY-MM-DD');
    if (dtstartDate !== undefined && !isValidDate(dtstartDate)) {
      return badRequest(reply, 'dtstartDate must be YYYY-MM-DD');
    }
    if (rrule !== undefined && !validateRRule(rrule, effectiveFrom)) {
      return badRequest(reply, `Invalid or unsupported RRULE: ${rrule}`);
    }
    if (!readRules(db, true).some((r) => r.id === id)) return notFound(reply, 'Rule not found');

    return previewRuleEdit(db, id, { rrule, dtstartDate, effectiveFrom });
  });

  app.delete('/api/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const settings = readSettings(db);
    const today = todayInTimeZone(settings.timezone, clock());
    if (!readRules(db, true).some((r) => r.id === id)) return notFound(reply, 'Rule not found');
    archiveRule(db, id, today);
    sync();
    return { archived: true };
  });

  // -- occurrences ----------------------------------------------------------

  /** The primary view: what is due on a given day. */
  app.get('/api/day', async (req, reply) => {
    const plan = sync();
    const date = single(body(req.query).date) ?? plan.today;
    if (!isValidDate(date)) return badRequest(reply, 'date must be YYYY-MM-DD');

    const settings = readSettings(db);
    const occurrences = readOccurrences(db, date, date);
    const rules = new Map(readRules(db, true).map((r) => [r.id, r]));

    return {
      date,
      today: plan.today,
      timezone: settings.timezone,
      // Rendered in the user's preferred calendar, so the client need not know
      // about conversions. Each rule also carries its own for the per-day view.
      calendarDate: toHijri(date, settings.defaultCalendar),
      items: occurrences.map((o) => decorate(o, rules)),
      recoveryPrompt: plan.recoveryPrompt,
      failedRules: plan.failedRules,
    };
  });

  app.get('/api/occurrences', async (req, reply) => {
    const plan = sync();
    const q = body(req.query);
    const from = single(q.from) ?? addDays(plan.today, -30);
    const to = single(q.to) ?? addDays(plan.today, 30);
    if (!isValidDate(from) || !isValidDate(to)) {
      return badRequest(reply, 'from and to must be YYYY-MM-DD');
    }
    if (to < from) return badRequest(reply, 'to must not precede from');
    const rules = new Map(readRules(db, true).map((r) => [r.id, r]));
    return readOccurrences(db, from, to).map((o) => decorate(o, rules));
  });

  app.post('/api/occurrences/:id/done', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = body(req.body);

    let at = clock().toISOString();
    if (input.at !== undefined) {
      if (typeof input.at !== 'string' || Number.isNaN(Date.parse(input.at))) {
        return badRequest(reply, 'at must be an ISO-8601 timestamp');
      }
      at = new Date(input.at).toISOString();
    }

    const existing = readOccurrence(db, id);
    if (!existing) return notFound(reply, 'Occurrence not found');
    if (existing.status !== 'pending') {
      return conflict(reply, `Occurrence is already ${existing.status}`);
    }
    return setOccurrenceStatus(db, id, 'done', at) ?? readOccurrence(db, id);
  });

  app.post('/api/occurrences/:id/missed', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = readOccurrence(db, id);
    if (!existing) return notFound(reply, 'Occurrence not found');
    if (existing.status !== 'pending') {
      return conflict(reply, `Occurrence is already ${existing.status}`);
    }
    return setOccurrenceStatus(db, id, 'missed', null) ?? readOccurrence(db, id);
  });

  /**
   * Undo a check-off. Only possible while the day is still open — once it has
   * closed the generator would sweep the row straight back to `missed`, so the
   * caller must use `/excuse` for a day that has passed.
   */
  app.post('/api/occurrences/:id/reset', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = readOccurrence(db, id);
    if (!existing) return notFound(reply, 'Occurrence not found');

    const settings = readSettings(db);
    // The injected clock, not wall time: tests freeze `now`, and "has this day
    // closed" must be answered in the same frame of reference as everything else.
    if (isOccurrenceElapsed(existing, settings, clock())) {
      return conflict(
        reply,
        "This day has already closed, so it cannot be reopened. Use /excuse to remove it from your adherence figures.",
      );
    }
    return resetOccurrence(db, id);
  });

  /** Excuse an occurrence: `skipped`, leaving the adherence denominator. */
  app.post('/api/occurrences/:id/excuse', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = readOccurrence(db, id);
    if (!existing) return notFound(reply, 'Occurrence not found');
    // A success on record must survive: excusing `done` would rewrite history.
    if (existing.status === 'done') {
      return conflict(reply, 'Occurrence is already done and cannot be excused');
    }
    const occ = excuseOccurrence(db, id);
    if (!occ) return notFound(reply, 'Occurrence not found');
    sync();
    return occ;
  });

  /**
   * Reassign an occurrence's status while its day is still open (R2.4's
   * exception in spirit: a mis-click is an explicit user action). Once the day
   * has closed the ledger is frozen — `excuse` stays the one deliberate exit.
   */
  app.post('/api/occurrences/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const status = body(req.body).status;
    if (status !== 'done' && status !== 'missed' && status !== 'skipped') {
      return badRequest(reply, 'status must be done, missed or skipped');
    }

    const result = changeOccurrenceStatus(db, id, status, readSettings(db), clock());
    if (result.ok) {
      sync();
      return result.occurrence;
    }
    if (result.reason === 'elapsed') {
      return conflict(reply, 'This day has already closed; its status is locked');
    }
    return notFound(reply, 'Occurrence not found');
  });

  /**
   * Set or clear the free-text note on an occurrence (R2.3). Annotation, not
   * ledger state: writable on any status, and it changes no adherence figure.
   */
  app.post('/api/occurrences/:id/note', async (req, reply) => {
    const { id } = req.params as { id: string };
    const raw = body(req.body);
    // Absent key is a malformed call, not a clear: clearing is explicit null.
    if (!('note' in raw)) return badRequest(reply, 'note is required');
    const note = optionalText(raw.note, 'note');
    if (!note.ok) return badRequest(reply, note.error);
    const occ = setOccurrenceNote(db, id, note.value?.trim() ? note.value.trim() : null);
    if (!occ) return notFound(reply, 'Occurrence not found');
    return occ;
  });

  /**
   * Excuse every unlogged occurrence in a date range. This is the recovery
   * prompt's "we were away" action: after a long absence the sweep marks a
   * wall of rows `missed`, and clearing that one by one is busywork.
   *
   * `done` rows are never touched; the route reports how many rows moved.
   */
  app.post('/api/occurrences/bulk-excuse', async (req, reply) => {
    const input = body(req.body);
    const from = single(input.from) ?? '';
    const to = single(input.to) ?? '';
    if (!isValidDate(from) || !isValidDate(to)) {
      return badRequest(reply, 'from and to must be YYYY-MM-DD');
    }
    if (to < from) return badRequest(reply, 'to must not precede from');
    if (daysBetween(from, to) > MAX_REPORT_SPAN_DAYS) {
      return badRequest(reply, `range must not exceed ${MAX_REPORT_SPAN_DAYS} days`);
    }

    let ruleIds: string[] | undefined;
    if (input.ruleIds !== undefined) {
      if (!Array.isArray(input.ruleIds) || input.ruleIds.length > 200) {
        return badRequest(reply, 'ruleIds must be an array of at most 200 rule ids');
      }
      if (input.ruleIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        return badRequest(reply, 'ruleIds must be an array of rule id strings');
      }
      ruleIds = input.ruleIds as string[];
    }

    const result = bulkExcuseOccurrences(db, from, to, ruleIds);
    sync();
    return result;
  });

  // -- skip periods ---------------------------------------------------------

  app.get('/api/skip-periods', async () => {
    sync();
    return readSkipPeriods(db);
  });

  app.post('/api/skip-periods', async (req, reply) => {
    const input = body(req.body);
    const start = single(input.startDate) ?? '';
    const end = single(input.endDate) ?? start;
    if (!isValidDate(start) || !isValidDate(end)) {
      return badRequest(reply, 'startDate and endDate must be YYYY-MM-DD');
    }
    if (end < start) return badRequest(reply, 'endDate must not precede startDate');

    const reason = optionalText(input.reason, 'reason');
    if (!reason.ok) return badRequest(reply, reason.error);

    const period = createSkipPeriod(db, start, end, reason.value);
    // Apply it to the freshly-settled window immediately.
    const plan = sync();
    return reply.code(201).send({ period, prompt: plan.recoveryPrompt });
  });

  app.delete('/api/skip-periods/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = deleteSkipPeriod(db, id);
    if (!removed) return notFound(reply, 'Skip period not found');
    sync();
    return { removed: true };
  });

  // -- push notifications ---------------------------------------------------
  // Web push needs VAPID credentials (see README). Without them the subscribe
  // and test routes answer 503 rather than accepting subscriptions that can
  // never fire. ntfy needs no server-side credentials, only a topic.

  const pushConfig: PushConfig = options.push ?? {};
  const pushUnavailable = (reply: FastifyReply) =>
    fail(reply, 503, 'Push notifications are not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');

  app.get('/api/push/public-key', async (req, reply) => {
    if (!pushConfigured(pushConfig)) return pushUnavailable(reply);
    return { publicKey: pushConfig.publicKey };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    if (!pushConfigured(pushConfig)) return pushUnavailable(reply);
    const input = body(req.body);
    const endpoint = single(input.endpoint) ?? '';
    const keys = input.keys && typeof input.keys === 'object' ? (input.keys as Record<string, unknown>) : null;
    const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh : '';
    const auth = keys && typeof keys.auth === 'string' ? keys.auth : '';
    if (!endpoint || endpoint.length > 2000) {
      return badRequest(reply, 'endpoint must be a non-empty URL of at most 2000 characters');
    }
    if (!/^https?:\/\//i.test(endpoint)) {
      return badRequest(reply, 'endpoint must be an http(s) URL');
    }
    if (!p256dh || p256dh.length > 500 || !auth || auth.length > 500) {
      return badRequest(reply, 'keys.p256dh and keys.auth must be non-empty strings');
    }
    const sub = saveSubscription(db, { endpoint, p256dh, auth });
    return reply.code(201).send({ subscribed: true, endpoint: sub.endpoint });
  });

  app.delete('/api/push/unsubscribe', async (req, reply) => {
    const input = body(req.body);
    const endpoint = single(input.endpoint) ?? '';
    if (!endpoint) return badRequest(reply, 'endpoint is required');
    const removed = deleteSubscription(db, endpoint);
    if (!removed) return notFound(reply, 'Subscription not found');
    return { removed: true };
  });

  app.post('/api/push/test', async (req, reply) => {
    const settings = readSettings(db);
    const ntfyOn = Boolean((settings.ntfyTopic ?? '').trim());
    const pushOn = pushConfigured(pushConfig) && listSubscriptions(db).length > 0;
    if (!pushOn && !ntfyOn) {
      return fail(reply, 503, 'No notification channel configured: subscribe a device or set an ntfy topic');
    }
    const result = await sendTestNotification(db, pushConfig);
    return result;
  });

  // -- statistics -----------------------------------------------------------

  app.get('/api/stats', async (req, reply) => {
    const plan = sync();
    const range = resolveRange(body(req.query), plan.today);
    if ('error' in range) return badRequest(reply, range.error);
    return buildPeriodReport(db, range.from, range.to);
  });

  // -- export / import ------------------------------------------------------
  // R7: the data outlives the app. JSON is the complete backup (and the one
  // format that imports back); CSV is the ledger for spreadsheets; VTODO
  // carries the schedules to any calendar tool.

  app.get('/api/export/json', async (req, reply) => {
    const plan = sync();
    const backup = readAllForBackup(db, clock());
    reply.header('Content-Disposition', `attachment; filename="takalif-backup-${plan.today}.json"`);
    return backup;
  });

  app.post('/api/import/json', async (req, reply) => {
    let counts;
    try {
      counts = restoreBackup(db, req.body);
    } catch (error) {
      const message = (error as Error).message;
      // Validated failures carry our own prefix. Anything else is a storage
      // detail (constraint names, SQL text) and must not reach the client.
      if (message.startsWith('Invalid backup at')) return badRequest(reply, message);
      req.log.error({ err: error }, 'backup restore failed');
      return badRequest(reply, 'Backup could not be restored: it failed database constraints');
    }
    sync();
    return { restored: true, ...counts };
  });

  app.get('/api/export/csv', async (req, reply) => {
    const plan = sync();
    const q = body(req.query);
    // An export with no range defaults to the trailing year. The complete
    // ledger is the JSON backup; an unbounded CSV would be a denial of
    // service on the event loop, hence the same 3660-day cap as reports.
    if (single(q.from) === undefined && single(q.to) === undefined && single(q.preset) === undefined) {
      q.preset = 'year';
    }
    const range = resolveRange(q, plan.today);
    if ('error' in range) return badRequest(reply, range.error);
    const csv = ledgerToCsv(readLedgerRows(db, range.from, range.to));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="takalif-ledger-${range.from}-${range.to}.csv"`,
    );
    return csv;
  });

  app.get('/api/export/vtodo', async (req, reply) => {
    sync();
    const ics = rulesToVCalendar(readRules(db, true), clock());
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="takalif-rules.ics"');
    return ics;
  });

  // -- health ---------------------------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    today: todayInTimeZone(readSettings(db).timezone, clock()),
  }));

  /**
   * LAN pairing details for the QR screen: this machine's LAN address plus
   * the bearer token a companion needs. Loopback-only — answering this on
   * the LAN would hand the keys to anyone listening. 400 when no token is
   * configured, since there is nothing to pair with.
   */
  app.get('/api/pairing', async (req, reply) => {
    if (!authToken) return badRequest(reply, 'LAN pairing is not enabled on this server');
    if (!isLoopback(req.ip)) {
      reply.code(403).send({ error: 'Pairing details are only available on this machine' });
      return;
    }
    // One snapshot for both fields: two enumerations could straddle a NIC
    // flap and disagree about which address is first.
    const nics = pickPairingInterfaces(networkInterfaces());
    return { lanIP: nics[0]?.address ?? null, interfaces: nics, token: authToken };
  });

  /**
   * Replace the pairing token. Loopback-only like the pairing readout, for
   * the same reason. Previously issued codes stop working immediately, so a
   * code that was shown to the wrong eyes dies on demand — no file spelunking.
   */
  app.post('/api/pairing/rotate', async (req, reply) => {
    if (!authToken || !authDir) return badRequest(reply, 'LAN pairing is not enabled on this server');
    if (!isLoopback(req.ip)) {
      reply.code(403).send({ error: 'Pairing details are only available on this machine' });
      return;
    }
    if (authPinned) {
      // Rotating would only kill the code until the next boot resurrects the
      // pinned value. Refuse loudly instead of selling temporary revocation.
      return conflict(
        reply,
        'This code is pinned by TAKALIF_TOKEN — unset it to enable rotation (the saved code then applies)',
      );
    }
    try {
      authToken = rotateToken(authDir);
    } catch (error) {
      req.log.error({ err: error }, 'pairing rotation failed to persist');
      reply.code(500).send({ error: 'Could not write the new code' });
      return;
    }
    return { token: authToken };
  });

  /**
   * Refuse any request that declares a cross-origin browser context we did not
   * allow. This is the actual access boundary: `origin: false` in the CORS
   * config only strips the response headers, and a script can still *send* the
   * request and act on a simple-response side effect.
   *
   * Second boundary in the same hook: when an auth token is configured,
   * non-loopback callers must present it on every API route except
   * /api/health. Loopback stays open — the desktop shell, curl, and the test
   * harness all speak from this machine.
   *
   * A request carrying the valid bearer skips the Origin check below: the
   * token is the authentication, and a cross-site attacker cannot know it
   * (it is never ambient like a cookie). Preflight OPTIONS carries no
   * credentials by design, so it passes through to the CORS handler, which
   * answers from the allowlist above.
   */
  app.addHook('onRequest', async (request, reply) => {
    // LAN token boundary first: it applies regardless of Origin, because a
    // non-browser client (curl, a script, another device) sends none at all.
    // Matched on the path, not the raw URL, so a query string on an exempt
    // route cannot flip the decision.
    const pathname = request.url.split('?')[0] ?? '';
    if (
      authToken &&
      pathname.startsWith('/api/') &&
      pathname !== '/api/health' &&
      !isLoopback(request.ip) &&
      bearerToken(request.headers.authorization) !== authToken
    ) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    if (request.method === 'OPTIONS') return;
    if (authToken && bearerToken(request.headers.authorization) === authToken) return;

    const origin = request.headers.origin;
    if (origin === undefined || allowedOrigins.has(origin) || NATIVE_ORIGINS.includes(origin)) {
      return;
    }

    // A browser sending `Origin` is always cross-origin: the app has no
    // multi-host story, and the PWA it serves is same-origin. So an origin
    // that is not ours is refused outright, on read and on write alike.
    const own = request.headers.host;
    const originHost = origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (own && originHost === own) return;

    reply.code(403).send({ error: 'Origin not allowed' });
  });

  return app;
}

function decorate(
  o: Occurrence,
  rules: Map<string, Pick<Rule, 'title' | 'category' | 'calendar'>>,
) {
  const rule = rules.get(o.ruleId);
  return {
    ...o,
    ruleTitle: rule?.title ?? '(archived)',
    category: rule?.category ?? null,
    // The rule's own calendar, so a Hijri rule can display its Hijri date.
    ruleCalendar: rule?.calendar ?? GREGORIAN,
  };
}

function resolveRange(
  q: Record<string, unknown>,
  today: string,
): { from: string; to: string } | { error: string } {
  // Trailing windows: adherence looks back at what happened, never forward at
  // what is still pending (which would always report null).
  const presets: Record<string, [number, number]> = {
    week: [6, 0],
    month: [29, 0],
    quarter: [89, 0],
    year: [364, 0],
  };

  const asSingle = (value: unknown): string | undefined =>
    Array.isArray(value) ? (typeof value[0] === 'string' ? value[0] : undefined) : typeof value === 'string' ? value : undefined;

  const from = asSingle(q.from);
  const to = asSingle(q.to);

  if (from && to) {
    // Reject an impossible date before anything else: `0001-01-01` is
    // well-formed but not a real day, and it is not a range-width problem.
    if (!isValidDate(from) || !isValidDate(to)) {
      return { error: 'from and to must be YYYY-MM-DD' };
    }
    if (to < from) return { error: 'to must not precede from' };
    // An unbounded span is a denial of service on the event loop: each month
    // of trend used to be produced by a full scan of the occurrence list.
    if (daysBetween(from, to) > MAX_REPORT_SPAN_DAYS) {
      return { error: `range must not exceed ${MAX_REPORT_SPAN_DAYS} days` };
    }
    return { from, to };
  }

  const preset = asSingle(q.preset) ?? 'month';
  const span = presets[preset];
  if (!span) return { error: `Unknown preset: ${preset}` };
  return { from: addDays(today, -span[0]), to: addDays(today, span[1]) };
}