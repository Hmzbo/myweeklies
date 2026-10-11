import { useState } from 'react';
import type { Settings } from '@takalif/core';
import { api } from './api';
import { getConnection, isCompanion } from './connection.js';
import { useOnline, useResource, useTheme } from './data';
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconGear,
  IconGrid,
  IconMoon,
  IconSun,
  IconSunDim,
} from './icons';
import { CalendarView } from './components/CalendarView';
import { ConnectView } from './components/ConnectView';
import { RulesView } from './components/RulesView';
import { SettingsView } from './components/SettingsView';
import { StatsView, type ReviewRange } from './components/StatsView';
import { TodayView } from './components/TodayView';

type Tab = 'today' | 'calendar' | 'rules' | 'stats' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof IconCheck }[] = [
  { id: 'today', label: 'Today', icon: IconCheck },
  { id: 'calendar', label: 'Calendar', icon: IconCalendar },
  { id: 'rules', label: 'Tasks', icon: IconClock },
  { id: 'stats', label: 'Stats', icon: IconGrid },
  { id: 'settings', label: 'Settings', icon: IconGear },
];

const THEMES = [
  { id: 'system', label: 'System theme', icon: IconSunDim },
  { id: 'light', label: 'Light theme', icon: IconSun },
  { id: 'dark', label: 'Dark theme', icon: IconMoon },
] as const;

/**
 * A `?date=YYYY-MM-DD` query param deep-links to that day. Notification taps
 * use it so a reminder opens on the day it refers to; anything else is
 * ignored and the view falls back to today.
 */
function initialDateParam(): string | null {
  try {
    const date = new URLSearchParams(window.location.search).get('date');
    return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>('today');
  const online = useOnline();
  const { theme, setTheme } = useTheme();
  const settings = useResource<Settings>('settings', () => api.settings());

  // Set by the recovery prompt's "Review" action: jump to Stats showing that range.
  const [reviewRange, setReviewRange] = useState<ReviewRange | null>(null);
  const [reviewNonce, setReviewNonce] = useState(0);

  // The day Today shows. Calendar sets it when jumping to a date; Today owns
  // paging from there. Lifted here so the date survives tab switches.
  const [dayDate, setDayDate] = useState<string | null>(initialDateParam);
  // Bumped when Today's "New task" is tapped: Tasks opens straight into the form.
  const [createRequest, setCreateRequest] = useState(0);
  // Companion gate: a native shell with no stored server has nothing to show
  // yet. PWA and desktop never enter this branch — same-origin always works.
  const [connected, setConnected] = useState(
    () => !isCompanion() || getConnection() !== null,
  );

  function reviewRangeAction(from: string, to: string) {
    setReviewRange({ from, to });
    setReviewNonce((n) => n + 1);
    setTab('stats');
  }

  function openDay(date: string) {
    setDayDate(date);
    setTab('today');
  }

  function startCreateTask() {
    setCreateRequest((n) => n + 1);
    setTab('rules');
  }

  return (
    <>
      <header className="app-header">
        {!online && (
          <div className="offline-bar" role="status">
            You are offline. Showing what was last fetched — changes will fail until you reconnect.
          </div>
        )}
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✓
            </span>
            Takalif
          </span>
          <div className="seg" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className="seg-btn"
                aria-pressed={theme === t.id}
                aria-label={t.label}
                title={t.label}
                onClick={() => setTheme(t.id as typeof theme)}
              >
                <t.icon />
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="app">
        {!connected ? (
          <ConnectView onConnected={() => setConnected(true)} />
        ) : (
          <>
        {tab === 'today' && (
          <TodayView
            settings={settings.data}
            onReviewRange={reviewRangeAction}
            date={dayDate}
            onDateChange={setDayDate}
            onNewTask={startCreateTask}
          />
        )}
        {tab === 'calendar' && (
          <CalendarView settings={settings.data} onSelectDate={openDay} />
        )}
        {tab === 'rules' && (
          <RulesView onChanged={() => settings.refresh()} createRequest={createRequest} />
        )}
        {tab === 'stats' && <StatsView reviewRange={reviewRange} reviewNonce={reviewNonce} />}
        {tab === 'settings' && (
          <SettingsView
            onChanged={() => settings.refresh()}
            companion={isCompanion() && connected}
            onDisconnect={() => setConnected(false)}
          />
        )}
          </>
        )}
      </main>

      <nav className="tabs" aria-label="Sections">
        <div className="sidebar-brand" aria-hidden="true">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          Takalif
        </div>
        <div className="tabs-inner">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="tab"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              <span className="tab-icon" aria-hidden="true">
                <t.icon />
              </span>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
