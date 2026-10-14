/**
 * Pairing payload contract, versioned 1 (http servers) and 2 (TLS servers).
 *
 * The desktop renders this as a QR code; the companion scans it and learns
 * where the server lives, which bearer token its LAN calls need, and — from
 * v2 — the SHA-256 fingerprint of the server's self-signed certificate
 * (ADR 0019-era TLS listener). The fingerprint is the trust anchor: it
 * reaches the phone through the camera, never over the wire, so a
 * man-in-the-middle cannot impersonate the server (trust-on-first-use).
 *
 * JSON with an explicit version so a future format fails loudly on old
 * readers instead of misconfiguring them. Only `http(s)` URLs — a QR code is
 * an injection vector for whoever scans it, so exotic schemes never validate.
 * Placeholder address in copy and comments; no real LAN address here.
 */
export interface PairingPayload {
  v: 1 | 2;
  /** Base URL of the server, e.g. `http://<PC-IP>:8787`. No path. */
  url: string;
  /** Bearer token for LAN API calls. */
  token: string;
  /** SHA-256 of the certificate DER, lowercase hex, 64 chars — v2 only. */
  fp?: string;
}

export const PAIRING_VERSION_LATEST = 2 as const;

function fail(reason: string): never {
  throw new Error(`Invalid pairing payload: ${reason}`);
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Build the exact string that goes into the QR code. A fingerprint upgrades
 * the payload to v2; without one it stays v1 — an https server that cannot
 * prove itself must not produce a silent downgrade, so https URLs REQUIRE
 * the fingerprint.
 */
export function buildPairingPayload(
  url: string,
  token: string,
  fingerprint?: string,
): string {
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
  if (fingerprint !== undefined) {
    if (!FINGERPRINT_RE.test(fingerprint)) fail('fingerprint must be 64 lowercase hex chars');
    // A fingerprint over http is a QR claiming verification it did not do:
    // v2 is the TLS contract, http is v1 and stays v1.
    if (parsed.protocol !== 'https:') fail('a fingerprint is only meaningful with https');
  }
  let payload: PairingPayload;
  if (fingerprint === undefined) {
    if (parsed.protocol === 'https:') fail('an https pairing needs the certificate fingerprint');
    payload = { v: 1, url: parsed.toString().replace(/\/$/, ''), token: cleanToken };
  } else {
    payload = {
      v: PAIRING_VERSION_LATEST,
      url: parsed.toString().replace(/\/$/, ''),
      token: cleanToken,
      fp: fingerprint,
    };
  }
  return JSON.stringify(payload);
}

/** Parse scanned QR content back into a payload. Throws descriptively. Old
 *  v1 readers keep working on v1 codes; v2 codes demand an old reader to
 *  fail loudly rather than scan past the trust anchor. */
export function parsePairingPayload(text: string): PairingPayload {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    fail('not JSON — is this a Takalif pairing code?');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) fail('must be an object');
  const obj = doc as Record<string, unknown>;
  if (obj.v === 1) {
    if (typeof obj.url !== 'string' || !obj.url) fail('url must be a non-empty string');
    if (typeof obj.token !== 'string' || !obj.token) fail('token must be a non-empty string');
    // Re-validate through the builder so parse accepts exactly what build
    // emits — including the https-needs-fingerprint rule.
    return JSON.parse(buildPairingPayload(obj.url, obj.token)) as PairingPayload;
  }
  if (obj.v !== PAIRING_VERSION_LATEST) fail(`unsupported version ${JSON.stringify(obj.v)}`);
  if (typeof obj.url !== 'string' || !obj.url) fail('url must be a non-empty string');
  if (typeof obj.token !== 'string' || !obj.token) fail('token must be a non-empty string');
  if (typeof obj.fp !== 'string' || !obj.fp) fail('v2 requires the certificate fingerprint');
  return JSON.parse(buildPairingPayload(obj.url, obj.token, obj.fp)) as PairingPayload;
}

/**
 * Server base URL from a LAN address and a port, on the given scheme. Port
 * 80/443 stay implicit; other schemes than http are refused.
 */
export function pairingUrl(
  lanIP: string,
  port: string | number,
  scheme: 'http' | 'https' = 'http',
): string {
  const host = lanIP.trim();
  if (!host) fail('LAN address is empty');
  // Colons would let a host smuggle its own port (or a bare IPv6 address,
  // which needs brackets the companion does not speak yet) into the URL.
  if (/[\s/:]/.test(host)) fail('LAN address must be a bare hostname or IPv4');
  const portNum = typeof port === 'string' && port === '' ? NaN : Number(port);
  const portPart =
    port === '' || (portNum === 80 && scheme === 'http') || (portNum === 443 && scheme === 'https')
      ? ''
      : `:${portNum}`;
  if (!Number.isInteger(portNum) && portPart !== '') fail('port must be an integer');
  if (portPart !== '' && (portNum < 1 || portNum > 65535)) fail('port out of range');
  return `${scheme}://${host}${portPart}`;
}
