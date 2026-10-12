import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

/**
 * Self-signed TLS certificate for the LAN listener, generated once and pinned
 * by companions through the QR payload (trust-on-first-use).
 *
 * Threat model: WiFi plaintext was the documented invasion; TLS closes it. The
 * fingerprint in the QR travels by camera — off the wire — so a man-in-the-
 * middle cannot impersonate the server without holding the phone's camera.
 * Losing the keystore file (fresh install, wiped data dir) is recovered by
 * re-pairing: a fresh QR always carries the current fingerprint.
 *
 * Deliberately no hostname verification on the client side: the server is an
 * IP address on a LAN, and the pinned fingerprint IS the identity. This is the
 * Syncthing pattern (self-signed certs + device-ID TOFU), not a new scheme.
 *
 * Generation must be injectable for tests: `now` stamps createdAt, and the
 * key material differs per call, but the fingerprint of a persisted keystore
 * is what matters — call twice on the same dir, get the same fingerprint.
 */
export interface Keystore {
  /** PEM private key. Never leaves this machine. */
  keyPem: string;
  /** PEM leaf certificate, self-signed, ~10-year validity. */
  certPem: string;
  /** SHA-256 of the certificate DER, lowercase hex. This goes in the QR. */
  fingerprint: string;
  createdAt: string;
}

const KEYSTORE_FILE = 'takalif-https.json';

/** PEM payload → DER bytes: strip armor, decode the base64 body. */
export function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

/** The fingerprint the QR carries: SHA-256 of the cert DER, lowercase hex. */
export function certFingerprint(certPem: string): string {
  return createHash('sha256').update(pemToDer(certPem)).digest('hex');
}

/**
 * Load the persisted keystore, or generate one. Two calls on the same
 * directory return the same key material — a fingerprint change would strand
 * every paired companion with a pin failure, so persistence is the contract.
 */
export async function loadOrCreateKeystore(dir: string): Promise<Keystore> {
  const file = join(dir, KEYSTORE_FILE);
  if (existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Partial<Keystore>;
      if (
        typeof doc.keyPem === 'string' &&
        typeof doc.certPem === 'string' &&
        typeof doc.fingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(doc.fingerprint) &&
        doc.fingerprint === certFingerprint(doc.certPem)
      ) {
        return {
          keyPem: doc.keyPem,
          certPem: doc.certPem,
          fingerprint: doc.fingerprint,
          createdAt: String(doc.createdAt ?? ''),
        };
      }
      // A truncated or tampered keystore must not serve TLS with a
      // fingerprint nobody knows: fall through and mint a fresh one.
    } catch {
      // Malformed file: regenerate below.
    }
  }
  const notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const generated = await selfsigned.generate(
    [
      { name: 'commonName', value: 'Takalif' },
      { name: 'organizationName', value: 'Takalif' },
    ],
    {
      keySize: 2048,
      notAfterDate: notAfter,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'takalif.local' }] },
      ],
    },
  );
  const keystore: Keystore = {
    keyPem: generated.private,
    certPem: generated.cert,
    fingerprint: certFingerprint(generated.cert),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(keystore, null, 2), 'utf8');
  return keystore;
}
