import type {
  CalendarKind,
  HijriDate,
  Occurrence,
  OccurrenceStatus,
  PeriodReport,
  Rule,
  Settings,
  SkipPeriod,
} from '@takalif/core';
import { Capacitor } from '@capacitor/core';
import { getConnection, type ServerConnection } from './connection.js';

/** An occurrence as returned by /api/day and /api/occurrences (see `decorate`). */
export interface DayItem extends Occurrence {
  ruleTitle: string;
  category: string | null;
  ruleCalendar: CalendarKind;
}

export interface DayResponse {
  date: string;
  today: string;
  timezone: string;
  calendarDate: HijriDate;
  items: DayItem[];
  recoveryPrompt: {
    from: string;
    to: string;
    count: number;
    ruleIds: string[];
  } | null;
  failedRules: { ruleId: string; rrule: string; error: string }[];
}

export interface RulesResponse {
  rules: Rule[];
  failedRules: DayResponse['failedRules'];
}

export interface EditPreview {
  added: string[];
  withdrawn: Occurrence[];
  neutralised: Occurrence[];
  changed: boolean;
}

export interface SkipPeriodCreated {
  period: SkipPeriod;
  prompt: DayResponse['recoveryPrompt'];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** True inside the native companion shell. PWA and desktop: always false. */
export function isCompanion(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

function normalizeHeaders(value: HeadersInit | undefined): Record<string, string> {
  if (!value) return {};
  if (value instanceof Headers) {
    const out: Record<string, string> = {};
    value.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(value)) return Object.fromEntries(value);
  return { ...(value as Record<string, string>) };
}

/**
 * Resolve where a call goes. Pure and fully tested. Native shell with a
 * stored connection → LAN base plus bearer; everything else → the
 * same-origin call the PWA and desktop have always made.
 */
export function buildEndpoint(
  path: string,
  conn: ServerConnection | null,
  native: boolean,
): Endpoint {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (conn && native) {
    return { url: `${conn.url}${path}`, headers: { ...headers, authorization: `Bearer ${conn.token}` } };
  }
  return { url: path, headers };
}

async function readError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
      message = data.error;
    }
  } catch {
    // Non-JSON error body: the status-based default stands.
  }
  return new ApiError(res.status, message);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, headers } = buildEndpoint(path, getConnection(), isCompanion());
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...headers, ...normalizeHeaders(init?.headers) } });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?');
  }
  if (!res.ok) throw await readError(res);
  const text = await res.text();
  return (text ? (JSON.parse(text) as unknown) : null) as T;
}

/** Read a JSON body, throwing the server's error message on bad status. */
async function throwIfJson(res: Response): Promise<unknown> {
  if (!res.ok) throw await readError(res);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

/** Unauthenticated liveness check for the Connect screen: /health needs no bearer. */
export async function probeServer(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/health`);
  } catch {
    throw new ApiError(
      0,
      `Cannot reach ${url}. Same WiFi as the server, and is it running?`,
    );
  }
  const data = await throwIfJson(res);
  if (data === null || typeof data !== 'object') {
    throw new ApiError(res.status, `That address answers, but it is not a Takalif server.`);
  }
  const { ok, today } = data as { ok?: unknown; today?: unknown };
  if (ok !== true || typeof today !== 'string') {
    throw new ApiError(res.status, `That address answers, but it is not a Takalif server.`);
  }
  return today;
}

export type ExportKind = 'json' | 'csv' | 'ics';

const EXPORT_PATHS: Record<ExportKind, string> = {
  json: '/api/export/json',
  csv: '/api/export/csv',
  ics: '/api/export/vtodo',
};

const EXPORT_FALLBACK: Record<ExportKind, string> = {
  json: 'takalif-backup.json',
  csv: 'takalif-ledger.csv',
  ics: 'takalif-rules.ics',
};

/** Fetch an export through the same authenticated channel as everything else
 *  (plain anchors can carry no bearer). The caller turns blob+filename into a
 *  download, which keeps DOM out of this module and the logic testable. */
export async function fetchExport(kind: ExportKind): Promise<{ blob: Blob; filename: string }> {
  const { url, headers } = buildEndpoint(EXPORT_PATHS[kind], getConnection(), isCompanion());
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?');
  }
  if (!res.ok) throw await readError(res);
  const blob = await res.blob();
  const filename =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    EXPORT_FALLBACK[kind];
  return { blob, filename };
}

/** Save a fetched export via a temporary object URL. */
export async function downloadExport(kind: ExportKind): Promise<void> {
  const { blob, filename } = await fetchExport(kind);
  const href = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const api = {
  health: () => request<{ ok: boolean; today: string }>('/api/health'),

  settings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings & { failedRules: DayResponse['failedRules'] }>(
      '/api/settings',
      withBody('PATCH', patch),
    ),

  rules: () => request<RulesResponse>('/api/rules'),
  createRule: (input: {
    title: string;
    description?: string | null;
    rrule: string;
    dtstartDate?: string;
    dueTime?: string | null;
    reminderTime?: string | null;
    calendar?: CalendarKind;
    createdDate?: string;
    trackStreak?: boolean;
    category?: string | null;
  }) => request<Rule>('/api/rules', withBody('POST', input)),
  updateRule: (
    id: string,
    input: {
      title?: string;
      description?: string | null;
      rrule?: string;
      dtstartDate?: string;
      dueTime?: string | null;
      reminderTime?: string | null;
      calendar?: CalendarKind;
      trackStreak?: boolean;
      category?: string | null;
      effectiveFrom?: string;
    },
  ) => request<Rule>(`/api/rules/${id}`, withBody('PATCH', input)),
  editPreview: (id: string, params: { rrule?: string; dtstartDate?: string; effectiveFrom?: string }) => {
    const q = new URLSearchParams();
    if (params.rrule) q.set('rrule', params.rrule);
    if (params.dtstartDate) q.set('dtstartDate', params.dtstartDate);
    if (params.effectiveFrom) q.set('effectiveFrom', params.effectiveFrom);
    return request<EditPreview>(`/api/rules/${id}/edit-preview?${q.toString()}`);
  },
  archiveRule: (id: string) => request<{ archived: boolean }>(`/api/rules/${id}`, { method: 'DELETE' }),

  day: (date?: string) =>
    request<DayResponse>(date ? `/api/day?date=${encodeURIComponent(date)}` : '/api/day'),
  occurrences: (from: string, to: string) =>
    request<DayItem[]>(
      `/api/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  reset: (id: string) => request<Occurrence>(`/api/occurrences/${id}/reset`, withBody('POST', {})),  changeStatus: (id: string, status: 'done' | 'missed' | 'skipped') =>
    request<Occurrence>(`/api/occurrences/${id}/status`, withBody('POST', { status })),
  excuse: (id: string) =>
    request<Occurrence>(`/api/occurrences/${id}/excuse`, withBody('POST', {})),
  setNote: (id: string, note: string | null) =>
    request<Occurrence>(`/api/occurrences/${id}/note`, withBody('POST', { note })),
  bulkExcuse: (input: { from: string; to: string; ruleIds?: string[] }) =>
    request<{ excused: number }>('/api/occurrences/bulk-excuse', withBody('POST', input)),

  skipPeriods: () => request<SkipPeriod[]>('/api/skip-periods'),
  createSkipPeriod: (input: { startDate: string; endDate: string; reason?: string | null }) =>
    request<SkipPeriodCreated>('/api/skip-periods', withBody('POST', input)),
  deleteSkipPeriod: (id: string) =>
    request<{ removed: boolean }>(`/api/skip-periods/${id}`, { method: 'DELETE' }),

  stats: (preset?: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from && to) {
      q.set('from', from);
      q.set('to', to);
    } else {
      q.set('preset', preset ?? 'month');
    }
    return request<PeriodReport>(`/api/stats?${q.toString()}`);
  },

  pushPublicKey: () => request<{ publicKey: string }>('/api/push/public-key'),
  pushSubscribe: (input: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ subscribed: boolean; endpoint: string }>(
      '/api/push/subscribe',
      withBody('POST', input),
    ),
  pushUnsubscribe: (endpoint: string) =>
    request<{ removed: boolean }>('/api/push/unsubscribe', withBody('DELETE', { endpoint })),
  pushTest: () =>
    request<{ checked: number; sent: number; failed: number; pruned: number }>(
      '/api/push/test',
      withBody('POST', {}),
    ),

  pairing: () =>
    request<{ lanIP: string | null; interfaces: { name: string; address: string }[]; token: string }>(
      '/api/pairing',
    ),
  rotatePairing: () => request<{ token: string }>('/api/pairing/rotate', withBody('POST', {})),

  importBackup: (doc: unknown) =>
    request<{ restored: boolean; rules: number; occurrences: number }>(
      '/api/import/json',
      withBody('POST', doc),
    ),
};

export type { OccurrenceStatus };
export type { CalendarKind, HijriDate, Occurrence, PeriodReport, Rule, Settings, SkipPeriod };
