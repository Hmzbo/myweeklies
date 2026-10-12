import { Capacitor } from '@capacitor/core';
import { buildPairingPayload, parsePairingPayload } from './pairing.js';

/**
 * Where this client talks to. The PWA and desktop shell use same-origin
 * requests and never touch this — it exists for the companion, which bundles
 * the same UI but must reach a server on the LAN with a bearer token.
 *
 * Stored in localStorage (private-mode safe: every access is guarded and
 * degrades to unconfigured). A null connection means same-origin behaviour.
 */
export interface ServerConnection {
  url: string;
  token: string;
  /**
   * SHA-256 of the server's certificate DER, from a v2 pairing payload.
   * Present means the companion pins the connection (an https URL without a
   * fingerprint is refused by the contract instead). Absent on v1 http
   * pairings; the channel is the bearer token, as documented.
   */
  fingerprint?: string;
}

const KEY = 'takalif-server';

/** True inside the native companion shell. PWA and desktop: always false. */
export function isCompanion(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function getConnection(): ServerConnection | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as { url?: unknown; token?: unknown; fp?: unknown };
    if (typeof doc.url !== 'string' || !doc.url || typeof doc.token !== 'string' || !doc.token) {
      return null;
    }
    // A corrupt fingerprint must never produce an unpinnable https entry:
    // validate through the pairing contract, which refuses https without one.
    if (doc.fp !== undefined && (typeof doc.fp !== 'string' || !doc.fp)) return null;
    parsePairingPayload(
      JSON.stringify(
        doc.fp === undefined ? { v: 1, url: doc.url, token: doc.token } : { v: 2, url: doc.url, token: doc.token, fp: doc.fp },
      ),
    );
    return {
      url: doc.url.replace(/\/$/, ''),
      token: doc.token,
      ...(doc.fp === undefined ? {} : { fingerprint: doc.fp as string }),
    };
  } catch {
    return null;
  }
}

/** Persist a connection. Throws descriptively on invalid input. */
export function setConnection(
  url: string,
  token: string,
  fingerprint?: string,
): ServerConnection {
  const canonical = JSON.parse(
    buildPairingPayload(url, token, fingerprint),
  ) as ServerConnection & { v: number };
  const conn: ServerConnection =
    fingerprint === undefined
      ? { url: canonical.url, token: canonical.token }
      : { url: canonical.url, token: canonical.token, fingerprint: canonical.fingerprint };
  const store = storage();
  if (!store) throw new Error('Storage is unavailable on this device');
  try {
    store.setItem(KEY, JSON.stringify(conn));
  } catch {
    throw new Error('Storage is unavailable on this device');
  }
  return conn;
}

/** Accept a scanned QR payload (`{"v":1|2,"url":…,"token":…[,"fp":…]}`) and
 *  store it. The fingerprint, when present, comes with the URL it belongs to. */
export function connectWithCode(text: string): ServerConnection {
  const payload = parsePairingPayload(text);
  const fingerprint = payload.v === 2 ? payload.fp : undefined;
  return setConnection(payload.url, payload.token, fingerprint);
}

export function clearConnection(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Already gone or unreachable; the observable state is the same.
  }
}
