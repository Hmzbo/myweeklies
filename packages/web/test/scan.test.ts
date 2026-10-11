import { describe, expect, it, vi } from 'vitest';
import {
  isCancelError,
  onRestoredScan,
  scanPairingCode,
  warmScannerModule,
  type RestoredEvent,
} from '../src/scan.js';

const okScanner = (text: string | null) => ({
  isSupported: async () => ({ supported: true }),
  scan: async () => ({ barcodes: text === null ? [] : [{ displayValue: text }] }),
});

describe('scanPairingCode', () => {
  it('returns the scanned text', async () => {
    await expect(scanPairingCode(okScanner('{"v":1}'))).resolves.toBe('{"v":1}');
  });

  it('prefers the raw value when present', async () => {
    const scanner = {
      isSupported: async () => ({ supported: true }),
      scan: async () => ({ barcodes: [{ displayValue: 'cooked', rawValue: 'raw' }] }),
    };
    await expect(scanPairingCode(scanner)).resolves.toBe('raw');
  });

  it('refuses unsupported devices in plain language', async () => {
    const scanner = { ...okScanner('x'), isSupported: async () => ({ supported: false }) };
    await expect(scanPairingCode(scanner)).rejects.toThrow(/by hand/);
  });

  it('treats an empty scan as try-again, not a crash', async () => {
    await expect(scanPairingCode(okScanner(null))).rejects.toThrow(/try again/);
  });

  it('translates cancellation and permission errors', async () => {
    const cancelled = {
      ...okScanner('x'),
      scan: async () => {
        throw new Error('Scan canceled');
      },
    };
    await expect(scanPairingCode(cancelled)).rejects.toThrow(/cancelled — nothing/);
    const denied = {
      ...okScanner('x'),
      scan: async () => {
        throw new Error('permission denied for camera');
      },
    };
    await expect(scanPairingCode(denied)).rejects.toThrow(/system settings/);
  });

  it('treats a missing scanner module as not-ready-yet', async () => {
    const missing = {
      ...okScanner('x'),
      scan: async () => {
        throw new Error('The Google Barcode Scanner Module is not available, please try again later.');
      },
    };
    await expect(scanPairingCode(missing)).rejects.toThrow(/not ready yet/);
  });

  it('classifies cancellations for silent handling', () => {
    expect(isCancelError('scan canceled.')).toBe(true);
    expect(isCancelError('Scan canceled')).toBe(true);
    expect(isCancelError('The scan result was lost because the app process was terminated.')).toBe(false);
  });

  it('warms the module only on native, never throwing', async () => {
    let called = 0;
    const fake = { installGoogleBarcodeScannerModule: async () => void called++ };
    await warmScannerModule(fake);
    expect(called).toBe(0);
    vi.stubGlobal('androidBridge', {});
    await warmScannerModule(fake);
    expect(called).toBe(1);
    const failing = {
      installGoogleBarcodeScannerModule: async () => {
        throw new Error('no play');
      },
    };
    await expect(warmScannerModule(failing)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('onRestoredScan', () => {
  const listener = () => {
    let handler: ((info: RestoredEvent) => void) | null = null;
    return {
      events: {
        addListener: async (_event: 'appRestoredResult', h: (info: RestoredEvent) => void) => {
          handler = h;
          return { remove: async () => undefined };
        },
      },
      fire: (info: RestoredEvent) => handler?.(info),
    };
  };

  it('recovers a scan result delivered after process death', async () => {
    const t = listener();
    vi.stubGlobal('androidBridge', {});
    const seen: unknown[] = [];
    const unsubscribe = await onRestoredScan((r) => void seen.push(r), t.events);
    t.fire({
      pluginId: 'BarcodeScanner',
      methodName: 'scan',
      success: true,
      data: { barcodes: [{ displayValue: 'restored-code' }] },
    });
    expect(seen).toEqual([{ text: 'restored-code', error: null }]);
    await unsubscribe();
    vi.unstubAllGlobals();
  });

  it('ignores unrelated restore events', async () => {
    const t = listener();
    vi.stubGlobal('androidBridge', {});
    const seen: unknown[] = [];
    await onRestoredScan((r) => void seen.push(r), t.events);
    t.fire({ pluginId: 'Other', methodName: 'scan', success: true, data: {} });
    expect(seen).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('is a no-op off native without touching events', async () => {
    const events = { addListener: vi.fn() };
    const unsubscribe = await onRestoredScan(() => undefined, events);
    expect(events.addListener).not.toHaveBeenCalled();
    await unsubscribe();
  });
});
