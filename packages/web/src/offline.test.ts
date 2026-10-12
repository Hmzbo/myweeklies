import { describe, expect, it } from 'vitest';
import {
  MAX_QUEUE,
  MAX_SLOTS,
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
  type SlotStore,
} from './offline';
import { ApiError } from './api';

const T = (n: number) => `2026-10-${String(n).padStart(2, '0')}T09:00:00.000Z`;

const item = (over: Partial<QueuedStatus> = {}): QueuedStatus => ({
  occurrenceId: 'occ-1',
  scheduledDate: '2026-10-11',
  to: 'done',
  queuedAt: T(11),
  ...over,
});

describe('slot store', () => {
  it('puts and gets slots', () => {
    let store: SlotStore = slotPut({}, '2026-10-10', { items: [] }, T(10));
    expect(slotGet(store, '2026-10-10')?.fetchedAt).toBe(T(10));
    // Refreshing a key does not grow the store.
    store = slotPut(store, '2026-10-10', { items: [1] }, T(11));
    expect(Object.keys(store)).toEqual(['2026-10-10']);
    expect(slotGet(store, '2026-10-10')?.data).toEqual({ items: [1] });
  });

  it("evicts the least-recently fetched slot over the cap — not the most-used or the first", () => {
    let store: SlotStore = {};
    // Fill to the cap: 90 slots fetched in order 1..90, so slot 1 is stalest.
    for (let i = 1; i <= MAX_SLOTS; i++) {
      store = slotPut(store, `day-${i}`, i, T(i));
    }
    // Touch an old one to prove eviction uses recency, not position.
    store = slotPut(store, 'day-40', 'refreshed', T(91));
    store = slotPut(store, 'day-new', 'new', T(92));
    expect(slotGet(store, 'day-new')).toBeDefined();
    expect(slotGet(store, 'day-40')?.data).toBe('refreshed');
    expect(slotGet(store, 'day-1')).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(MAX_SLOTS);
  });

  it('scores stay valid after churn: every survivor keeps its own data', () => {
    let store: SlotStore = {};
    for (let i = 1; i <= MAX_SLOTS + 5; i++) {
      store = slotPut(store, `day-${i}`, { n: i }, T(i));
    }
    // The freshest five survive.
    for (let i = MAX_SLOTS + 1; i <= MAX_SLOTS + 5; i++) {
      expect(slotGet(store, `day-${i}`)?.data).toEqual({ n: i });
    }
  });
});

describe('outbox', () => {
  it('appends under the cap and refuses loudly at the cap', () => {
    let queue: QueuedStatus[] = [];
    for (let i = 0; i < MAX_QUEUE; i++) {
      const step = enqueueStatus(queue, item({ occurrenceId: `occ-${i}` }));
      expect(step.ok).toBe(true);
      queue = step.queue;
    }
    expect(queue).toHaveLength(MAX_QUEUE);
    const refused = enqueueStatus(queue, item({ occurrenceId: 'occ-over' }));
    expect(refused.ok).toBe(false);
    expect(refused.queue).toHaveLength(MAX_QUEUE);
    expect(refused.queue.some((q) => q.occurrenceId === 'occ-over')).toBe(false);
  });

  it('advances from the front: replay order is arrival order', () => {
    const queue = [
      item({ occurrenceId: 'a', queuedAt: T(1) }),
      item({ occurrenceId: 'b', queuedAt: T(2) }),
    ];
    expect(advanceQueue(queue, 1).map((q) => q.occurrenceId)).toEqual(['b']);
    expect(advanceQueue(queue, 0).map((q) => q.occurrenceId)).toEqual(['a', 'b']);
    expect(advanceQueue([], 3)).toEqual([]);
  });

  it('trims an over-long persisted queue on load, never on the cap edge only', () => {
    const storage = fakeStorage();
    saveQueue(storage, Array.from({ length: MAX_QUEUE + 7 }, (_, i) => item({ occurrenceId: `occ-${i}` })));
    expect(loadQueue(storage)).toHaveLength(MAX_QUEUE);
  });
});

describe('optimistic overlay', () => {
  const day = {
    items: [
      { id: 'a', scheduledDate: '2026-10-11', status: 'pending', completedAt: null },
      { id: 'b', scheduledDate: '2026-10-11', status: 'skipped', completedAt: null },
    ],
  };

  it('marks done with a local completion stamp', () => {
    const next = overlayStatus(day, 'a', 'done', T(11));
    expect(next.items[0]).toEqual({ id: 'a', scheduledDate: '2026-10-11', status: 'done', completedAt: T(11) });
    expect(next.items[1].status).toBe('skipped');
  });

  it('clears the stamp when un-doing, mirroring changeStatus server-side', () => {
    const doneDay = overlayStatus(day, 'a', 'done', T(11));
    const next = overlayStatus(doneDay, 'a', 'skipped', T(12));
    expect(next.items[0]).toEqual({ id: 'a', scheduledDate: '2026-10-11', status: 'skipped', completedAt: null });
  });

  it('never mutates the slot data under user scroll', () => {
    overlayStatus(day, 'a', 'done', T(11));
    expect(day.items[0].status).toBe('pending');
  });
});

describe('persistence', () => {
  it('roundtrips slots and queue through a storage sandbox', () => {
    const storage = fakeStorage();
    saveSlots(storage, slotPut({}, '2026-10-10', { items: ['x'] }, T(10)));
    saveQueue(storage, [item()]);
    expect(loadSlots(storage)).toEqual(
      slotPut({}, '2026-10-10', { items: ['x'] }, T(10)),
    );
    expect(loadQueue(storage)).toEqual([item()]);
  });

  it('starts empty on corrupt payloads instead of crashing on boot', () => {
    const storage = fakeStorage();
    storage.setItem('takalif-offline-slots-v1', '{not json');
    storage.setItem('takalif-offline-queue-v1', '{"occurrenceId":"occ-1"}');
    expect(loadSlots(storage)).toEqual({});
    expect(loadQueue(storage)).toEqual([]);
  });

  it('rejects queue entries with unknown statuses (a planted tamper attempt)', () => {
    const storage = fakeStorage();
    storage.setItem(
      'takalif-offline-queue-v1',
      JSON.stringify([
        { occurrenceId: 'a', scheduledDate: '2026-10-11', to: 'pending', queuedAt: T(1) },
        item(),
      ]),
    );
    expect(loadQueue(storage)).toEqual([]);
  });

  it('survives saving over a full quota by keeping the in-memory copy', () => {
    const storage = fakeStorage({ quota: 10 });
    saveQueue(storage, [item()]);
    expect(loadQueue(storage)).toEqual([]); // nothing persisted — as designed
  });
});

describe('isNetworkError', () => {
  it('queues only on true offline-ness: a 5xx or 4xx is a server verdict, not offline-ness', () => {
    expect(isNetworkError(new ApiError(0, 'off'))).toBe(true);
    expect(isNetworkError(new ApiError(403, 'closed'))).toBe(false);
    expect(isNetworkError(new ApiError(500, 'boom'))).toBe(false);
    expect(isNetworkError(new Error('plain'))).toBe(false);
  });
});

function fakeStorage(over: { quota?: number } = {}): StorageLikeTest {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (over.quota !== undefined && v.length > over.quota) {
        throw new Error('quota exceeded');
      }
      map.set(k, v);
    },
  };
}

interface StorageLikeTest {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
