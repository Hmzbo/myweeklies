import type { OccurrenceStatus } from '@takalif/core';
import { ApiError } from './api';

/**
 * The offline replica (ADR 0019): a bounded read cache plus a durable outbox.
 * The server stays the only writer of truth; this module is pure storage and
 * arithmetic over it, so every rule that matters — eviction, caps, optimistic
 * overlay shape — can be table-tested without React or a network.
 *
 * What may queue offline: status changes only. Rule edits and settings carry
 * domain logic the client must not reimplement; the server arbitrates every
 * replayed change through the ordinary endpoints.
 */

/** Recency stamp format used by both halves. ISO strings sort correctly. */
type Stamp = string;

export interface Slot<T = unknown> {
  fetchedAt: Stamp;
  data: T;
}

export type SlotStore<T = unknown> = Record<string, Slot<T>>;

/** Slots kept at most. ~3 months of single days or a handful of ranges. */
export const MAX_SLOTS = 90;

/** Outbox entries kept at most. Far beyond realistic offline volume; a cap
 *  protects storage so a runaway queue cannot wedge the device. */
export const MAX_QUEUE = 100;

/** True when the failure is "could not reach the server" — the only shift
 *  under which a status change queues. A 5xx is a server hiccough to show;
 *  a 4xx is a refusal to show; neither is offline-ness. */
export function isNetworkError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

/** Insert or refresh a slot, stamping recency, evicting the least-recently
 *  fetched slot when over the cap. Returns a new object; inputs untouched. */
export function slotPut<T>(
  store: SlotStore<T>,
  key: string,
  data: T,
  now: Stamp,
): SlotStore<T> {
  const next: SlotStore<T> = {};
  for (const [k, v] of Object.entries(store)) {
    if (k !== key) next[k] = v;
  }
  next[key] = { fetchedAt: now, data };
  const keys = Object.keys(next);
  if (keys.length > MAX_SLOTS) {
    let oldestKey: string | null = null;
    let oldestAt = '';
    for (const k of keys) {
      const v = next[k];
      if (v !== undefined && (oldestKey === null || v.fetchedAt < oldestAt)) {
        oldestKey = k;
        oldestAt = v.fetchedAt;
      }
    }
    if (oldestKey !== null) delete next[oldestKey];
  }
  return next;
}

export function slotGet<T>(store: SlotStore<T>, key: string): Slot<T> | undefined {
  return store[key];
}

/**
 * One outbox entry: intent, not state. `scheduledDate` names the day the
 * occurrence belongs to, so the UI can point at the slot for optimistic
 * overlay and explain a closed-day rejection ("kept as missed") which the
 * server answers on replay.
 */
export interface QueuedStatus {
  occurrenceId: string;
  scheduledDate: string;
  /** Only the three actionable statuses: pending means "do nothing", which
   *  is not an offline intent worth queueing. */
  to: 'done' | 'missed' | 'skipped';
  queuedAt: Stamp;
}

/**
 * Append an intent under the cap. Refusing to trim history silently is the
 * whole point of the cap failing loudly: the caller tells the user that
 * offline changes are being rejected rather than dropping the oldest ones.
 */
export function enqueueStatus(
  queue: readonly QueuedStatus[],
  item: QueuedStatus,
): { queue: QueuedStatus[]; ok: boolean } {
  if (queue.length >= MAX_QUEUE) return { queue: [...queue], ok: false };
  return { queue: [...queue, item], ok: true };
}

/** Remove the first `count` items — the ones the replay just resolved. */
export function advanceQueue(
  queue: readonly QueuedStatus[],
  count: number,
): QueuedStatus[] {
  if (count === 0) return [...queue];
  return queue.slice(Math.min(count, queue.length));
}

export interface DayLikeItem {
  id: string;
  scheduledDate: string;
  status: OccurrenceStatus;
  completedAt?: string | null;
}

export interface DayLike {
  items: DayLikeItem[];
}

/**
 * Optimistic overlay: what a successful status POST would leave behind, so
 * the offline UI reads the user's intent immediately. `done` stamps a local
 * completion time (the server's authoritative value replaces it on the next
 * fetch); anything else clears it, mirroring `changeStatus` server-side.
 * Generic on the day's real type so callers keep their shape; immutable —
 * slot data is shared structure under user scroll.
 */
export function overlayStatus<T extends DayLike>(
  day: T,
  occurrenceId: string,
  to: 'done' | 'missed' | 'skipped',
  now: Stamp,
): T {
  return {
    ...day,
    items: day.items.map((item) =>
      item.id === occurrenceId
        ? { ...item, status: to, completedAt: to === 'done' ? now : null }
        : item,
    ),
  };
}

export interface OfflineState<T = unknown> {
  slots: SlotStore<T>;
  queue: QueuedStatus[];
}

export const EMPTY_OFFLINE: OfflineState = { slots: {}, queue: [] };

/* Persistence — injected storage keeps this pure and testable. The real
 * implementation passes localStorage; private-mode browsers (and enterprise
 * storage policies) degrade to in-memory-only, which is honest: those changes
 * never claimed to survive a reload. */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SLOTS_KEY = 'takalif-offline-slots-v1';
const QUEUE_KEY = 'takalif-offline-queue-v1';

export function loadSlots(storage: StorageLike): SlotStore {
  try {
    const raw = storage.getItem(SLOTS_KEY);
    if (!raw) return {};
    const doc = JSON.parse(raw) as SlotStore;
    if (!doc || typeof doc !== 'object') return {};
    for (const slot of Object.values(doc)) {
      if (
        !slot ||
        typeof slot.fetchedAt !== 'string' ||
        typeof slot.data !== 'object' ||
        slot.data === null
      ) {
        return {};
      }
    }
    return doc;
  } catch {
    return {};
  }
}

export function saveSlots(storage: StorageLike, store: SlotStore): void {
  try {
    storage.setItem(SLOTS_KEY, JSON.stringify(store));
  } catch {
    // Quota/serialization failure: the in-memory copy stays authoritative
    // for this session; a later save can still succeed.
  }
}

export function loadQueue(storage: StorageLike): QueuedStatus[] {
  try {
    const raw = storage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const doc = JSON.parse(raw) as QueuedStatus[];
    if (!Array.isArray(doc)) return [];
    if (!doc.every(isQueuedStatus)) return [];
    return doc.slice(0, MAX_QUEUE);
  } catch {
    return [];
  }
}

export function saveQueue(storage: StorageLike, queue: readonly QueuedStatus[]): void {
  try {
    storage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(0, MAX_QUEUE)));
  } catch {
    // Same stance as saveSlots.
  }
}

function isQueuedStatus(v: unknown): v is QueuedStatus {
  if (!v || typeof v !== 'object') return false;
  const q = v as Record<string, unknown>;
  return (
    typeof q.occurrenceId === 'string' &&
    typeof q.scheduledDate === 'string' &&
    (q.to === 'done' || q.to === 'missed' || q.to === 'skipped') &&
    typeof q.queuedAt === 'string'
  );
}
