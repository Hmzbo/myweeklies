import { Capacitor, registerPlugin } from '@capacitor/core';
import { ApiError, PIN_MISMATCH_STATUS } from './errors.js';

/**
 * The pinned transport bridge.
 *
 * In the companion, every API call rides the native OkHttp channel
 * (PinnedHttpPlugin.java) so the certificate fingerprint from a v2 pairing
 * payload can be enforced — the WebView network stack cannot pin. Everywhere
 * else (PWA, desktop webview) the plain `fetch` is the transport, and the
 * bridge is inert. Tests inject a fake driver instead of a native plugin.
 *
 * Error contract, mirrored from the plugin's tags in the rejected message:
 * - `NET: …`  → unreachable / refused / timeout → ApiError(0): offline-ness
 * - `PIN: …`  → certificate did not match its pin → ApiError(511), and the
 *   message tells the user to re-pair. 511 is deliberate: isNetworkError()
 *   keys on status 0, and a pin mismatch must never be swallowed by the
 *   offline queue (ADR 0019) — the server that answered is not (only) the
 *   server the user paired.
 * - `TLS: …`  → handshake failed for other transport reasons → ApiError(0)
 */

interface PinnedHttpBridge {
  /** Returns a text body plus the few headers the web layer may reuse. */
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    fingerprint?: string;
  }): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
}

interface TransportInit {
  method?: string;
  body?: string | null;
  headers?: Record<string, string>;
}

/** The real bridge. Registration is lazy-harmless in the PWA: no call is
 *  ever made before `pinnedAvailable()` says the native side exists. */
const bridge = registerPlugin<PinnedHttpBridge>('PinnedHttp');

export interface TransportDriver {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | null;
    fingerprint?: string;
  }): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
}

let testDriver: TransportDriver | null = null;

/** Test seam: unit tests inject here; production code never does. */
export function setTransportDriver(driver: TransportDriver | null): void {
  testDriver = driver;
}

/** True only where a native PinnedHttp plugin is registered (the companion). */
export function pinnedAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PinnedHttp');
  } catch {
    return false;
  }
}

/**
 * One call site for every fetch in api.ts. Picks the native pinned channel
 * when available, falling back to the plain fetch elsewhere. A fingerprint
 * applies only inside the native channel; the WebView fetch keeps its own,
 * unchanged semantics.
 */
export async function transport(url: string, init?: TransportInit, fingerprint?: string): Promise<Response> {
  const driver = testDriver ?? (pinnedAvailable() ? bridge : null);
  if (driver) {
    try {
      const out = await driver.request({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers,
        body: init?.body ?? undefined,
        fingerprint,
      });
      const headers = new Headers(out.headers ?? {});
      return new Response(out.body, { status: out.status, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('PIN:')) {
        throw new ApiError(
          PIN_MISMATCH_STATUS,
          'The server answered with a certificate that does not match your pairing code. ' +
            'Re-pair: Desktop Settings → Pair a device → scan again. If nothing changed ' +
            'there, someone is in the middle — stop and check.',
        );
      }
      throw new ApiError(0, 'Cannot reach the server. Is it running?');
    }
  }
  try {
    return await fetch(url, {
      method: init?.method,
      body: init?.body ?? undefined,
      headers: init?.headers,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?');
  }
}
