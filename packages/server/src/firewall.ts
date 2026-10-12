import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * One-tap Windows firewall consent for phone pairing.
 *
 * Windows refuses unsolicited inbound connections on every network profile,
 * and the server's Node sidecar never gets a firewall prompt of its own — so
 * a phone times out until a rule exists, with no way to discover that from
 * inside the app. This module owns the one elevated command that adds it.
 *
 * The rule covers every listener port the companions use, both HTTP and the
 * TLS one, scoped to TCP only. It applies to all network profiles: homes move
 * between Private and Public classification and the ledger should not depend
 * on the current one.
 *
 * Elevation is explicit: the button press is the consent. Nothing here runs
 * at install time or boot time, and reading existing rules is unprivileged.
 */

/** One stable rule name — idempotence hinges on it. */
export const FIREWALL_RULE_NAME = 'Takalif companion (8787-8788)';

/** Ports the companions call: the server's own and the TLS listener. */
export const FIREWALL_PORT_RANGE = '8787-8788';

/**
 * The command the executor runs. Readable and reviewable on purpose: a
 * firewall helper that hides what it executes deserves no consent. Exit 2
 * means the rule already exists — checked unprivileged, so a second press
 * never re-runs elevation. Start-Process -Wait raises when the UAC prompt is
 * declined, which maps to 'declined' rather than 'failed'.
 */
export function firewallScript(): string {
  const ruleName = FIREWALL_RULE_NAME.replace(/'/g, "''");
  const netshArgs = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name="${ruleName}"`,
    'dir=in', 'action=allow', 'protocol=TCP',
    `localport=${FIREWALL_PORT_RANGE}`,
  ].join(' ');
  return [
    `$n = '${ruleName}'`,
    'if (-not (Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)) {',
    `  Start-Process netsh -Verb RunAs -Wait -ErrorAction Stop -ArgumentList '${netshArgs.replace(/'/g, "''")}'`,
    '}',
  ].join('; ');
}

export interface ExecutorOutcome {
  /** PowerShell exit code: 0 added the rule, 2 it already existed. */
  code: number;
  stderr: string;
}

export type FirewallExecutor = (script: string) => Promise<ExecutorOutcome>;

/** The real execution path: elevated netsh via an interactive UAC prompt. */
export const windowsFirewallExecutor: FirewallExecutor = async (script) => {
  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    return { code: 0, stderr: '' };
  } catch (error) {
    const e = error as { code?: number | string; stderr?: string; message?: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { code, stderr: (e.stderr ?? e.message ?? String(error)).slice(0, 500) };
  }
};

export type FirewallOutcome =
  | { status: 'opened' }
  | { status: 'already' }
  | { status: 'declined'; message: string }
  | { status: 'failed'; message: string };

/** Translate an exit code into what the button should say. Injected executors
 *  (tests) return the same shape, so gating and mapping are testable on any
 *  host, including the Linux CI runner. */
export function mapFirewallOutcome(outcome: ExecutorOutcome): FirewallOutcome {
  if (outcome.code === 0) return { status: 'opened' };
  if (outcome.code === 2) return { status: 'already' };
  if (/cancel(ed)? by the user|canceled by the user|access is denied/i.test(outcome.stderr)) {
    return { status: 'declined', message: outcome.stderr };
  }
  return { status: 'failed', message: outcome.stderr || `netsh exited ${outcome.code}` };
}
