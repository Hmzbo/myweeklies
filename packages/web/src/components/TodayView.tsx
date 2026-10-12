import { useMemo, useState } from 'react';
import { api, type DayResponse } from '../api';
import { runMutation, useResource } from '../data';
import { calendarLabel, formatCalendarDate, formatDayLabel, shiftDate } from '../format';
import { IconPlus } from '../icons';
import {
  attemptReplay,
  discardRejected,
  excuseRejected,
  isNetworkError,
  latestDaySlot,
  cacheDay,
  peekDay,
  pendingFor,
  queueStatus,
  useOfflineSnapshot,
} from '../sync';
import type { DayItem } from '../api';
import { Banner, ErrorBanner, Skeleton } from '../ui';
import type { Settings } from '@takalif/core';

const STATUS_LABEL: Record<DayItem['status'], string> = {
  pending: 'Due',
  done: 'Done',
  missed: 'Missed',
  skipped: 'Skipped',
};

const DISMISSED_KEY = 'takalif-recovery-dismissed';

/**
 * Offered after a long absence, when the sweep recorded a wall of failures.
 *
 * "We were away" excuses the whole range at once via the bulk endpoint;
 * without it the only path was one tap per occurrence. Dismissal is stored
 * per range so the same prompt does not nag twice.
 */
function RecoveryBanner({
  from,
  to,
  count,
  ruleIds,
  onDone,
  onReviewRange,
}: {
  from: string;
  to: string;
  count: number;
  ruleIds: string[];
  onDone: () => void;
  onReviewRange: (from: string, to: string) => void;
}) {
  const key = `${from}:${to}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === key;
    } catch {
      return false;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, key);
    } catch {
      // Private browsing: dismissal lasts the session only. Acceptable.
    }
    setDismissed(true);
  };

  async function excuseAll() {
    setBusy(true);
    setError(null);
    const err = await runMutation(() => api.bulkExcuse({ from, to, ruleIds }));
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    dismiss();
    onDone();
  }

  return (
    <Banner kind="warn">
      <div>
        <strong>
          {count} unlogged occurrence{count === 1 ? '' : 's'}
        </strong>{' '}
        from {formatDayLabel(from)} to {formatDayLabel(to)}, recorded as missed.
      </div>
      {error && <div style={{ marginBlockStart: '0.4rem' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '0.4rem', marginBlockStart: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn small" disabled={busy} onClick={excuseAll}>
          {busy ? 'Excusing…' : 'We were away — excuse all'}
        </button>
        <button type="button" className="btn small ghost" onClick={() => onReviewRange(from, to)}>
          Review
        </button>
        <button type="button" className="btn small ghost" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </Banner>
  );
}

export function TodayView({
  settings,
  onReviewRange,
  date,
  onDateChange,
  onNewTask,
}: {
  settings: Settings | null;
  onReviewRange: (from: string, to: string) => void;
  date: string | null;
  onDateChange: (date: string | null) => void;
  onNewTask: () => void;
}) {
  const saved = useResource(
    `day:${date ?? 'today'}`,
    () => api.day(date ?? undefined).then((response) => (cacheDay(response), response)),
  );
  const snap = useOfflineSnapshot();

  // Offline reads: the slot the last successful fetch left behind, so the
  // day the user opened before the PC went down stays visible. When no date
  // is picked, the most recent slot stands in for "today".
  const fallback =
    saved.error && isNetworkError(saved.error)
      ? (date !== null ? peekDay(date)?.data ?? null : (latestDaySlot()?.data ?? null))
      : null;
  const effective: DayResponse | null = saved.data ?? fallback;
  const viewing = date ?? effective?.today ?? '';
  // Pending intent rides every render: a queued change must not flicker back
  // to its old status while a refetch is in flight.
  const data: DayResponse | null = useMemo(() => {
    if (!effective) return null;
    return pendingFor(effective.date, effective);
  }, [effective]);

  const isToday = !data || viewing === data.today;
  const [actionError, setActionError] = useState<string | null>(null);
  const [queuedInfo, setQueuedInfo] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const showFallback = saved.data === null && fallback !== null;

  /**
   * The offline-capable status change. A network failure on an open day
   * queues intent (ADR 0019) instead of failing the tap; anything the
   * *server* says — closed day, unknown occurrence — stays an error, because
   * only the server arbitrates those.
   */
  async function setStatus(
    item: DayItem,
    target: 'done' | 'missed' | 'skipped',
    excuse: boolean,
  ): Promise<void> {
    setBusyId(item.id);
    setActionError(null);
    setQueuedInfo(null);
    try {
      if (excuse) await api.excuse(item.id);
      else await api.changeStatus(item.id, target);
      saved.refresh();
    } catch (error) {
      if (!isNetworkError(error) || excuse || dayElapsedNow()) {
        setActionError(error instanceof Error ? error.message : String(error));
      } else {
        const ok = queueStatus(item.id, item.scheduledDate, target);
        if (ok) setQueuedInfo('Saved on this device — it will sync when the server is back.');
        else {
          setActionError(
            'Too many offline changes are waiting — open the app while connected to sync them, then try again.',
          );
        }
      }
    } finally {
      setBusyId(null);
    }
  }

  function dayElapsedNow(): boolean {
    const today = data?.today ?? '';
    return viewing !== '' && today !== '' && viewing < today;
  }

  /** A chip stays pressed when its intent is queued, even mid-refetch. */
  function queuedFor(id: string, to: 'done' | 'missed' | 'skipped'): boolean {
    return snap.entries.some((q) => q.occurrenceId === id && q.to === to);
  }

  async function act(id: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setActionError(null);
    const err = await runMutation(fn);
    setBusyId(null);
    if (err) {
      setActionError(err.message);
      return false;
    }
    saved.refresh();
    return true;
  }

  async function saveNote(id: string) {
    if (await act(id, () => api.setNote(id, noteDraft))) setNoteId(null);
  }

  async function clearNote(id: string) {
    if (await act(id, () => api.setNote(id, null))) setNoteId(null);
  }

  // The recorded truth about a server refusal of queued intent: the user can
  // keep the server's verdict or run the excuse path. Shown once, resolved
  // once; a refetch replaces the overlay either way.
  const rejectedReview = snap.rejected ? (
    <Banner kind="warn">
      <div>
        <strong>One offline change could not be applied.</strong>{' '}
        {formatDayLabel(snap.rejected.entry.scheduledDate)} →{' '}
        {STATUS_LABEL[snap.rejected.entry.to]}. {snap.rejected.message}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBlockStart: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            void excuseRejected();
          }}
        >
          Excuse it instead
        </button>
        <button
          type="button"
          className="btn small ghost"
          onClick={() => discardRejected()}
        >
          Keep what the server recorded
        </button>
      </div>
    </Banner>
  ) : null;

  return (
    <section aria-label="Today">
      <div className="row-between" style={{ marginBlockStart: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>Today</h2>
        <button type="button" className="btn primary new-pill" onClick={onNewTask}>
          <IconPlus /> New task
        </button>
      </div>
      <div className="day-nav">
        <button
          type="button"
          className="btn icon"
          aria-label="Previous day"
          onClick={() => onDateChange(shiftDate(viewing, -1))}
          disabled={!data}
        >
          ←
        </button>
        <div className="day-title">
          <strong>{viewing ? formatDayLabel(viewing) : '…'}</strong>
          <span>
            {data && settings
              ? formatCalendarDate(viewing, data.calendarDate, settings.defaultCalendar)
              : ''}
            {!isToday && data ? ` · today is ${formatDayLabel(data.today)}` : ''}
          </span>
        </div>
        <button
          type="button"
          className="btn icon"
          aria-label="Next day"
          onClick={() => onDateChange(shiftDate(viewing, 1))}
          disabled={!data}
        >
          →
        </button>
      </div>

      {!isToday && (
        <button type="button" className="btn small" onClick={() => onDateChange(null)}>
          Back to today
        </button>
      )}

      {saved.error &&
        !(saved.error.status === 0 && (snap.queued > 0 || data !== null)) && (
          <ErrorBanner error={saved.error} onRetry={saved.refresh} />
        )}
      {showFallback && !saved.data && (
        <Banner kind="warn">
          Offline — showing the last day this device fetched. Marking works and
          syncs when the server returns.
        </Banner>
      )}
      {queuedInfo && <Banner kind="info">{queuedInfo}</Banner>}
      {actionError && <Banner kind="error">{actionError}</Banner>}
      {rejectedReview}
      {snap.queued > 0 && (
        <div role="status">
          <Banner kind="info">
            {snap.queued} offline change{snap.queued === 1 ? '' : 's'} waiting to sync.
          </Banner>
        </div>
      )}
      {data?.recoveryPrompt && (
        <RecoveryBanner
          from={data.recoveryPrompt.from}
          to={data.recoveryPrompt.to}
          count={data.recoveryPrompt.count}
          ruleIds={data.recoveryPrompt.ruleIds}
          onDone={saved.refresh}
          onReviewRange={onReviewRange}
        />
      )}
      {data?.failedRules?.length ? (
        <Banner kind="warn">
          {data.failedRules.length === 1 ? 'A task' : `${data.failedRules.length} tasks`}{' '}
          could not be expanded, so{' '}
          {data.failedRules.length === 1 ? 'it is' : 'they are'} generating nothing. Check the
          tasks list.
        </Banner>
      ) : null}
      {saved.data === null && !data && saved.loading && <Skeleton />}

      {data && data.items.length === 0 && (
        <div className="empty">
          <p>Nothing due{isToday ? ' today' : ' on this day'}.</p>
          <p className="muted">Enjoy it, or add a task.</p>
        </div>
      )}

      {data?.items.map((item) => {
        // The view date being in the past means its day has closed: statuses
        // are locked, except the one deliberate exit — excusing a missed day.
        const dayElapsed = viewing !== '' && viewing < (data?.today ?? '');
        return (
          <article className="card" key={item.id}>
            <div className="item item-plain">
              <div className="item-main">
                <div className={`item-title${item.status === 'done' ? ' done' : ''}`}>
                  {item.ruleTitle}
                </div>
                <div className="item-meta">
                  {item.ruleCalendar !== 'gregorian' && (
                    <span className="pill hijri">{calendarLabel(item.ruleCalendar)}</span>
                  )}
                  {item.category && <span>{item.category}</span>}
                  {item.dueTime && <span>due {item.dueTime}</span>}
                </div>
                {item.note && noteId !== item.id && <div className="muted">{item.note}</div>}
                {noteId === item.id ? (
                  <form
                    className="note-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveNote(item.id);
                    }}
                  >
                    <input
                      type="text"
                      value={noteDraft}
                      maxLength={500}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="Add a note…"
                      aria-label="Occurrence note"
                    />
                    <button
                      type="submit"
                      className="btn small primary"
                      disabled={busyId === item.id}
                    >
                      Save
                    </button>
                    {item.note && (
                      <button
                        type="button"
                        className="btn small ghost"
                        disabled={busyId === item.id}
                        onClick={() => void clearNote(item.id)}
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn small"
                      disabled={busyId === item.id}
                      onClick={() => setNoteId(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="note-toggle">
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={busyId === item.id}
                      onClick={() => {
                        setNoteId(item.id);
                        setNoteDraft(item.note ?? '');
                      }}
                    >
                      {item.note ? 'Edit note' : 'Add note'}
                    </button>
                  </div>
                )}
              </div>
              <div className="item-actions">
                <div
                  className="status-chips"
                  role="group"
                  aria-label={`${item.ruleTitle}: status, currently ${STATUS_LABEL[item.status]}`}
                >
                  {(['done', 'missed', 'skipped'] as const).map((target) => (
                    <button
                      key={target}
                      type="button"
                      className={`chip${item.status === target ? ' current' : ''} ${target}`}
                      aria-pressed={item.status === target}
                      disabled={
                        busyId === item.id ||
                        (item.status === target &&
                          !queuedFor(item.id, target)) ||
                        (dayElapsed && !(item.status === 'missed' && target === 'skipped'))
                      }
                      onClick={() =>
                        void setStatus(
                          item,
                          target,
                          dayElapsed && item.status === 'missed' && target === 'skipped',
                        )
                      }
                    >
                      {STATUS_LABEL[target]}
                    </button>
                  ))}
                </div>
                {!dayElapsed && item.status !== 'pending' && (
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, () => api.reset(item.id))}
                  >
                    Undo
                  </button>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
