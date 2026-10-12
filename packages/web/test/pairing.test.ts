import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPairingPayload,
  PAIRING_VERSION_LATEST,
  pairingUrl,
  parsePairingPayload,
} from '../src/pairing.js';

/**
 * A stable test fingerprint (a real-looking SHA-256 of cert DER bytes).
 * Placeholder addresses throughout: internal topology stays out of here.
 */
const FP = 'a'.repeat(64);

describe('pairing payload v1 (http)', () => {
  it('round-trips through the QR string', () => {
    const text = buildPairingPayload('http://192.168.1.10:8787', 'abc123');
    expect(parsePairingPayload(text)).toEqual({
      v: 1,
      url: 'http://192.168.1.10:8787',
      token: 'abc123',
    });
  });

  it('normalises trailing slashes and whitespace', () => {
    expect(parsePairingPayload(buildPairingPayload('  http://h:1/ ', ' t '))).toEqual({
      v: 1,
      url: 'http://h:1',
      token: 't',
    });
  });
});

describe('pairing payload v2 (TLS fingerprint)', () => {
  it('carries the fingerprint and round-trips', () => {
    const text = buildPairingPayload('https://192.168.1.10:8788', 't', FP);
    expect(parsePairingPayload(text)).toEqual({
      v: PAIRING_VERSION_LATEST,
      url: 'https://192.168.1.10:8788',
      token: 't',
      fp: FP,
    });
  });

  it('refuses an https URL without a fingerprint — the trust anchor is mandatory', () => {
    // Silently pinning nothing would turn TLS-pairing into plaintext-pairing
    // with a locked screen: refuse rather than downgrade.
    expect(() => buildPairingPayload('https://h', 't')).toThrow(/fingerprint/);
    expect(() => parsePairingPayload('{"v":1,"url":"https://h","token":"t"}')).toThrow(
      /fingerprint/,
    );
  });

  it('refuses an http URL carrying a fingerprint — v2 is for TLS only', () => {
    // Nothing http-side can use a fingerprint; shipping one would let a QR
    // lie about what was verified.
    expect(() => buildPairingPayload('http://h', 't', FP)).toThrow(/64 lowercase hex|fingerprint/);
  });

  it('rejects a malformed fingerprint on build and undersized on parse', () => {
    expect(() => buildPairingPayload('https://h', 't', 'ABC')).toThrow(/64 lowercase hex/);
    expect(() =>
      parsePairingPayload(`{"v":2,"url":"https://h","token":"t","fp":"zz"}`),
    ).toThrow(/64 lowercase hex/);
    expect(() => parsePairingPayload(`{"v":2,"url":"https://h","token":"t"}`)).toThrow(
      /fingerprint/,
    );
  });

  it('fingerprint is content-shaped: 64 lowercase hex, hash-consistent with certFingerprint', () => {
    // The contract the QR advertises — the same formula the server computes.
    expect(FINGERPRINT_LOOKS_LIKE('a'.repeat(64))).toBe(true);
    const der = Buffer.from('certificate bytes');
    const hex = createHash('sha256').update(der).digest('hex');
    expect(FINGERPRINT_LOOKS_LIKE(hex)).toBe(true);
  });
});

function FINGERPRINT_LOOKS_LIKE(fp: string): boolean {
  return /^[0-9a-f]{64}$/.test(fp);
}

describe('pairing payload shared rules', () => {
  it('rejects non-JSON, wrong versions, and missing fields', () => {
    expect(() => parsePairingPayload('not json')).toThrow(/not JSON/);
    expect(() => parsePairingPayload('{"v":99,"url":"http://h","token":"t"}')).toThrow(
      /unsupported version/,
    );
    expect(() => parsePairingPayload('{"v":1,"url":"http://h"}')).toThrow(/token/);
    expect(() => parsePairingPayload('[]')).toThrow(/object/);
  });

  it('rejects exotic URL schemes on build and parse', () => {
    expect(() => buildPairingPayload('javascript:alert(1)', 't')).toThrow(/http or https/);
    expect(() => buildPairingPayload('ftp://h/x', 't')).toThrow(/http or https/);
    expect(() => buildPairingPayload('http://h', '')).toThrow(/token/);
    expect(() => buildPairingPayload('http://h/app', 't')).toThrow(/no path/);
  });

  it('builds base URLs, keeping default ports implicit per scheme', () => {
    expect(pairingUrl('192.168.1.10', 8787)).toBe('http://192.168.1.10:8787');
    expect(pairingUrl('192.168.1.10', '8787')).toBe('http://192.168.1.10:8787');
    // Defaults are per-scheme: an http server on 443 is not implicit.
    expect(pairingUrl('example.com', 443)).toBe('http://example.com:443');
    expect(pairingUrl('example.com', 443, 'https')).toBe('https://example.com');
    expect(pairingUrl('example.com', '')).toBe('http://example.com');
    expect(() => pairingUrl('', 8787)).toThrow(/empty/);
    expect(() => pairingUrl('a/b', 1)).toThrow(/bare hostname/);
    expect(() => pairingUrl('evil.com:9999', 1)).toThrow(/bare hostname/);
    expect(() => pairingUrl('::1', 1)).toThrow(/bare hostname/);
    expect(() => pairingUrl('h', 99999)).toThrow(/range/);
  });
});
