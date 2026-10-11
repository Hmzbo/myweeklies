import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { App as CapacitorApp } from '@capacitor/app';
import { isCompanion } from './connection.js';

/** Minimal surface this module uses — fakes slide in for tests. */
export interface ScannerLike {
  isSupported(): Promise<{ supported: boolean }>;
  scan(options: { formats: unknown[]; autoZoom: boolean }): Promise<{
    barcodes: { displayValue?: string; rawValue?: string }[];
  }>;
}

/** True for a user backing out — nothing went wrong, so no banner. */
export function isCancelError(message: string): boolean {
  return message === 'scan canceled.' || message === 'Scan canceled';
}

/** Raw app-restored event shape for the barcode scanner plugin. */
export interface RestoredEvent {
  pluginId: string;
  methodName: string;
  success: boolean;
  data?: { barcodes?: { displayValue?: string; rawValue?: string }[] };
  error?: { message: string };
}

export interface AppEventsLike {
  addListener(
    event: 'appRestoredResult',
    handler: (info: RestoredEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const realScanner: ScannerLike = {
  isSupported: () => BarcodeScanner.isSupported(),
  scan: (options) =>
    BarcodeScanner.scan(options as { formats: BarcodeFormat[]; autoZoom: boolean }),
};

/**
 * Scan one QR code with the system scanner UI and return its text.
 *
 * Throws plain-language errors for every failure: unsupported device, nothing
 * found, user backing out, missing scanner module. Callers display
 * `error.message` directly.
 */
export async function scanPairingCode(scanner: ScannerLike = realScanner): Promise<string> {
  let supported: boolean;
  try {
    supported = (await scanner.isSupported()).supported;
  } catch {
    throw new Error('Scanning is not available on this device — enter the details by hand.');
  }
  if (!supported) {
    throw new Error('This device cannot scan codes — enter the details by hand below.');
  }
  let barcodes: { displayValue?: string; rawValue?: string }[];
  try {
    barcodes = (await scanner.scan({ formats: [BarcodeFormat.QrCode], autoZoom: true }))?.barcodes ?? [];
  } catch (e) {
    throw new Error(translateScanError(e));
  }
  const first = barcodes[0];
  const text = first?.rawValue ?? first?.displayValue;
  if (!text) throw new Error('No code found — hold steady and try again.');
  return text;
}

/**
 * Best-effort warm-up: ask Play Services to fetch the scanner module ahead
 * of the first scan, so a fresh install does not fail its first attempt.
 * Silent by design — failure just means the first scan downloads it instead.
 * Native only.
 */
export async function warmScannerModule(scanner: {
  installGoogleBarcodeScannerModule?: () => Promise<void>;
} = BarcodeScanner): Promise<void> {
  if (!isCompanion()) return;
  try {
    await scanner.installGoogleBarcodeScannerModule?.();
  } catch {
    // Module arrives on demand at scan time instead.
  }
}

/** Plain-language mapping for every scan failure, foreground or restored. */
export function translateScanError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  // Exact known strings first: a broad /cancel/ would misreport a
  // module-download cancellation (retryable) as a user cancel (final).
  if (message === 'scan canceled.' || message === 'Scan canceled') {
    return 'Scan cancelled — nothing was connected.';
  }
  if (/permission|denied access to camera/i.test(message)) {
    return 'Camera permission was denied — allow it in the system settings, or enter the details by hand.';
  }
  if (/not available|not installed|missing module|was lost|terminated/i.test(message)) {
    return 'The scanner is not ready yet — try the scan again in a moment, or enter the details by hand.';
  }
  if (/cancel/i.test(message)) return 'Scan cancelled — nothing was connected.';
  return message || 'Scanning failed — try again, or enter the details by hand.';
}

export interface RestoredScan {
  text: string | null;
  error: string | null;
}

/**
 * The system may destroy the app while its scanner UI is open; the scan
 * promise then never settles. This listener recovers that result when the app
 * comes back. Native only; no-op elsewhere. Returns an unsubscribe function.
 */
export async function onRestoredScan(
  handler: (result: RestoredScan) => void,
  events: AppEventsLike = CapacitorApp,
): Promise<() => void> {
  if (!isCompanion()) return () => undefined;
  const listener = await events.addListener('appRestoredResult', (event) => {
    if (event.pluginId !== 'BarcodeScanner' || event.methodName !== 'scan') return;
    if (event.success) {
      const first = event.data?.barcodes?.[0];
      const text = first?.rawValue ?? first?.displayValue;
      handler(text ? { text, error: null } : { text: null, error: 'No code found — hold steady and try again.' });
    } else {
      handler({ text: null, error: event.error?.message ?? 'Scanning failed — try again.' });
    }
  });
  return () => void listener.remove();
}
