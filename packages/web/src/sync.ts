import { useEffect, useState } from 'react';
import type { OccurrenceStatus } from '@takalif/core';
import { api, type DayResponse } from './api';
import {
  advanceQueue,
  enqueueStatus,
  isNetworkError,
  loadQueue,
  loadSlots,
  overlayStatus,
  saveQueue,
  saveSlots,
  slotGet,
  slotPut,
  type QueuedStatus,
  type Slot,
  type SlotStore,
} from './offline';

/**
 * The offline-sync controller (ADR 0019). A module-level singleton because
 * the outbox is process state, not component state: every view sees the same
 * queue, and a tab switch must not forget what was queued.
 *
 * The server arbitrates replay through ordinary endpoints. This controller
 * owns only: reaching the server, feeding it the outbox in order, and
 * explaining refusals. It deliberately contains no domain rules — those are
 * the settled-rows invariants, already enforced server-side (ADR 0001), and
 * the client duplicates none of them.
 */
export interface RejectedStatus {
  entry: QueuedStatus;
  /** The server's own words, shown verbatim. */
  message: string;
}

export interface OfflineSnapshot {
  /**
   * Server reachability, probed — NOT navigator.onLine, which stays true
   * when the phone's Wi-Fi is fine and the PC is off. The header bar keys
   * off this so "PC down" is named honestly.
   */
  offline: boolean;
  queued: number;
  /** The outbox itself, for views that show per-item intent state. */
  entries: readonly QueuedStatus[];
  rejected: RejectedStatus | null;
  /** Bumped after a fully-drained replay; day views refetch on change. */
  syncedVersion: number;
}

export function daySlotKey(date: string): string {
  return `day:${date}`;
}

const storage = (): Storage => localStorage;

let slots: SlotStore = {};
let queue: QueuedStatus[] = [];
let offline = false;
let rejected: RejectedStatus | null = null;
let syncedVersion = 0;
const listeners = new Set<() => void>();

function persistSafely(): void {
  try {
    saveSlots(storage(), slots);
    saveQueue(storage(), queue);
  } catch {
    // No storage at all (rare embedded webviews): the in-memory copy stays
    // authoritative for the session and persistence simply does not exist.
  }
}

/** Loaded once at boot from main.tsx; GUI code never touches persistence. */
export function hydrateOffline(): void {
  try {
    slots = loadSlots(storage());
    queue = loadQueue(storage());
  } catch {
    // Same stance as persistSafely.
  }
}

function snapshot(): OfflineSnapshot {
  return { offline, queued: queue.length, entries: queue, rejected, syncedVersion };
}

function emit(): void {
  persistSafely();
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function offlineSnapshotStatic(): OfflineSnapshot {
  return snapshot();
}

/** React view into the controller. Re-renders on every emit. */
export function useOfflineSnapshot(): OfflineSnapshot {
  const [snap, setSnap] = useState(snapshot);
  useEffect(
    () => subscribe(() => setSnap(snapshot())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return snap;
}

/** Cache a fresh server response — every day view's loader calls this. */
export function cacheDay(response: DayResponse): void {
  slots = slotPut(slots, daySlotKey(response.date), response, new Date().toISOString());
  emit();
}

export function peekDay(date: string): Slot<DayResponse> | undefined {
  return slotGet(slots, daySlotKey(date)) as Slot<DayResponse> | undefined;
}

/**
 * Stand-in for "today" when offline: the most recently fetched day any view
 * has cached. Honest about being last sync, not authoritative.
 */
export function latestDaySlot(): Slot<DayResponse> | undefined {
  let best: Slot<DayResponse> | undefined;
  for (const slot of Object.values(slots) as Slot<DayResponse>[]) {
    if (
      slot.data &&
      typeof slot.data === 'object' &&
      Array.isArray((slot.data as { items?: unknown }).items) &&
      (best === undefined || slot.fetchedAt > best.fetchedAt)
    ) {
      best = slot;
    }
  }
  return best;
}

/**
 * Queue a status change after a network failure, overlaying the cached slot
 * so the UI flips even while offline. `ok: false` means the cap refused:
 * tell the user to connect and sync rather than dropping their oldest intent.
 */
export function queueStatus(
  occurrenceId: string,
  scheduledDate: string,
  to: 'done' | 'missed' | 'skipped',
): boolean {
  const step = enqueueStatus(queue, {
    occurrenceId,
    scheduledDate,
    to,
    queuedAt: new Date().toISOString(),
  });
  if (!step.ok) return false;
  queue = step.queue;
  const slot = slotGet(slots, daySlotKey(scheduledDate)) as Slot<DayResponse> | undefined;
  if (slot) {
    slots = slotPut(
      slots,
      daySlotKey(scheduledDate),
      overlayStatus(slot.data, occurrenceId, to, new Date().toISOString()),
      slot.fetchedAt,
    );
  }
  emit();
  return true;
}

/** The pending overlay for a specific day: what the user has asked for but
 *  the server has not yet confirmed. Views re-apply it to any fresh data so
 *  intent never disappears during a refetch. */
export function pendingFor(date: string, response: DayResponse): DayResponse {
  const mine = queue.filter((q) => q.scheduledDate === date);
  if (mine.length === 0) return response;
  const now = new Date().toISOString();
  return mine.reduce<DayResponse>(
    (acc, entry) => overlayStatus(acc, entry.occurrenceId, entry.to, now),
    response,
  );
}

/**
 * Drain the outbox to the server, oldest first. Stops on the first refusal
 * (there is nothing meaningful past a settled-row rejection to guess about);
 * stops silently but keeps everything if the server drops again. Returns
 * true only when the queue arrived empty AND stayed empty.
 */
export async function attemptReplay(): Promise<boolean> {
  try {
    await api.health();
    offline = false;
  } catch {
    offline = true;
    emit();
    return false;
  }
  while (queue.length > 0) {
    const entry = queue[0];
    if (entry === undefined) break;
    try {
      await api.changeStatus(entry.occurrenceId, entry.to);
      queue = advanceQueue(queue, 1);
      emit();
    } catch (error) {
      if (isNetworkError(error)) {
        offline = true;
        emit();
        return false;
      }
      // The server has spoken: it refuses this change. Default message for
      // a walled day: the sweep recorded it missed while we were offline.
      rejected = {
        entry,
        message: error instanceof Error ? error.message : 'The change could not be applied.',
      };
      emit();
      return false;
    }
  }
  syncedVersion += 1;
  emit();
  return true;
}

/**
 * Dismiss a rejected change, keeping whatever the server decided. The
 * authoritative state replaces the optimistic overlay on the next refetch.
 */
export function discardRejected(): void {
  queue = advanceQueue(queue, 1);
  rejected = null;
  syncedVersion += 1;
  emit();
}

/**
 * Excuse a rejected change as the deliberate exit: a missed day becomes
 * `skipped`. Only valid when the server recorded missed; any other refusal
 * just discards the intent.
 */
export async function excuseRejected(): Promise<void> {
  if (!rejected) return;
  const { entry } = rejected;
  try {
    await api.excuse(entry.occurrenceId);
  } catch {
    // Not in the "missed, open to excuse" state anymore — fall through and
    // drop the intent either way; the server's state is the truth.
  }
  discardRejected();
}

export { isNetworkError };
