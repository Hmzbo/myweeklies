/**
 * Pairing payload contract, version 1.
 *
 * The desktop renders this as a QR code; the companion scans it and learns
 * where the server lives and which bearer token its LAN calls need. JSON with
 * an explicit version so a future format fails loudly on old readers instead
 * of misconfiguring them. Only `http(s)` URLs — a QR code is an injection
 * vector for whoever scans it, so exotic schemes never validate.
 */
export interface PairingPayload {
  v: 1;
  /** Base URL of the server, e.g. `http://192.168.1.10:8787`. No path. */
  url: string;
  /** Bearer token for LAN API calls. */
  token: string;
}

export const PAIRING_VERSION = 1 as const;

function fail(reason: string): never {
  throw new Error(`Invalid pairing payload: ${reason}`);
}

/** Build the exact string that goes into the QR code. */
export function buildPairingPayload(url: string, token: string): string {
  const cleanUrl = url.trim();
  const cleanToken = token.trim();
  if (!cleanToken) fail('token must be a non-empty string');
  if (cleanToken.length > 500) fail('token is implausibly long');
  let parsed: URL;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    fail('url must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('url must use http or https');
  }
  // Base URL only: a path would silently redirect the companion's /api calls.
  if (parsed.pathname !== '/') fail('url must have no path');
  const payload: PairingPayload = { v: PAIRING_VERSION, url: parsed.toString().replace(/\/$/, ''), token: cleanToken };
  return JSON.stringify(payload);
}

/** Parse scanned QR content back into a payload. Throws descriptively. */
export function parsePairingPayload(text: string): PairingPayload {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    fail('not JSON — is this a Takalif pairing code?');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) fail('must be an object');
  const obj = doc as Record<string, unknown>;
  if (obj.v !== PAIRING_VERSION) fail(`unsupported version ${JSON.stringify(obj.v)}`);
  if (typeof obj.url !== 'string' || !obj.url) fail('url must be a non-empty string');
  if (typeof obj.token !== 'string' || !obj.token) fail('token must be a non-empty string');
  // Re-validate through the builder so parse accepts exactly what build emits.
  const canonical = JSON.parse(buildPairingPayload(obj.url, obj.token)) as PairingPayload;
  return canonical;
}

/** Server base URL from a LAN address and port. Port 80/443 stay implicit. */
export function pairingUrl(lanIP: string, port: string | number): string {
  const host = lanIP.trim();
  if (!host) fail('LAN address is empty');
  // Colons would let a host smuggle its own port (or a bare IPv6 address,
  // which needs brackets the companion does not speak yet) into the URL.
  if (/[\s/:]/.test(host)) fail('LAN address must be a bare hostname or IPv4');
  const portNum = typeof port === 'string' && port === '' ? NaN : Number(port);
  const portPart =
    port === '' || portNum === 80 || portNum === 443 ? '' : `:${portNum}`;
  if (!Number.isInteger(portNum) && portPart !== '') fail('port must be an integer');
  if (portPart !== '' && (portNum < 1 || portNum > 65535)) fail('port out of range');
  return `http://${host}${portPart}`;
}
