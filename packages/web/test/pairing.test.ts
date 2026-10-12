import { describe, expect, it } from 'vitest';
import {
  buildPairingPayload,
  pairingUrl,
  parsePairingPayload,
} from '../src/pairing.js';

describe('pairing payload', () => {
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

  it('rejects non-JSON, wrong versions, and missing fields', () => {
    expect(() => parsePairingPayload('not json')).toThrow(/not JSON/);
    expect(() => parsePairingPayload('{"v":2,"url":"http://h","token":"t"}')).toThrow(
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

  it('builds base URLs, keeping default ports implicit', () => {
    expect(pairingUrl('192.168.1.10', 8787)).toBe('http://192.168.1.10:8787');
    expect(pairingUrl('192.168.1.10', '8787')).toBe('http://192.168.1.10:8787');
    expect(pairingUrl('example.com', 443)).toBe('http://example.com');
    expect(pairingUrl('example.com', '')).toBe('http://example.com');
    expect(() => pairingUrl('', 8787)).toThrow(/empty/);
    expect(() => pairingUrl('a/b', 1)).toThrow(/bare hostname/);
    expect(() => pairingUrl('evil.com:9999', 1)).toThrow(/bare hostname/);
    expect(() => pairingUrl('::1', 1)).toThrow(/bare hostname/);
    expect(() => pairingUrl('h', 99999)).toThrow(/range/);
  });
});
