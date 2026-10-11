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
    const doc = JSON.parse(raw) as { url?: unknown; token?: unknown };
    if (typeof doc.url !== 'string' || !doc.url || typeof doc.token !== 'string' || !doc.token) {
      return null;
    }
    // Validate through the pairing contract so a corrupt entry can never
    // produce a malformed base URL or an empty bearer.
    parsePairingPayload(buildPairingPayload(doc.url, doc.token));
    return { url: doc.url.replace(/\/$/, ''), token: doc.token };
  } catch {
    return null;
  }
}

/** Persist a connection. Throws descriptively on invalid input. */
export function setConnection(url: string, token: string): ServerConnection {
  const canonical = JSON.parse(buildPairingPayload(url, token)) as ServerConnection & { v: number };
  const conn: ServerConnection = { url: canonical.url, token: canonical.token };
  const store = storage();
  if (!store) throw new Error('Storage is unavailable on this device');
  try {
    store.setItem(KEY, JSON.stringify(conn));
  } catch {
    throw new Error('Storage is unavailable on this device');
  }
  return conn;
}

/** Accept a pasted QR payload (`{"v":1,"url":…,"token":…}`) and store it. */
export function connectWithCode(text: string): ServerConnection {
  const payload = parsePairingPayload(text);
  return setConnection(payload.url, payload.token);
}

export function clearConnection(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Already gone or unreachable; the observable state is the same.
  }
}
