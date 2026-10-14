import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, PIN_MISMATCH_STATUS } from '../src/errors.js';
import { isNetworkError } from '../src/offline.js';
import { setTransportDriver, transport } from '../src/pinnedHttp.js';

const RESP = (status: number, body: string, headers?: Record<string, string>) => ({
  status,
  body,
  headers,
});

describe('transport driver', () => {
  beforeEach(() => setTransportDriver(null));

  it('routes through the injected driver and builds a Response', async () => {
    let seen: unknown;
    setTransportDriver({
      async request(o) {
        seen = o;
        return RESP(200, '{"ok":true,"today":"2026-10-14"}', { 'content-type': 'application/json' });
      },
    });
    const res = await transport('http://h/api/health', { method: 'GET' }, 'a'.repeat(64));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"ok":true');
    expect((seen as { fingerprint?: string }).fingerprint).toBe('a'.repeat(64));
    expect(String(res.headers.get('content-type'))).toContain('json');
  });

  it('maps a pin mismatch to 511 — never offline-ness, never queued', async () => {
    setTransportDriver({
      async request() {
        throw new Error('PIN: the server certificate does not match');
      },
    });
    try {
      await transport('https://h/api/health', {}, 'a'.repeat(64));
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(PIN_MISMATCH_STATUS);
      // The offline queue keys on status 0; this must fail that gate loudly.
      expect(isNetworkError(error)).toBe(false);
      expect((error as Error).message).toContain('Re-pair');
    }
  });

  it('maps a transport refusal to offline-ness (ApiError 0)', async () => {
    setTransportDriver({
      async request() {
        throw new Error('NET: could not reach the server');
      },
    });
    await expect(transport('http://h/api/health')).rejects.toMatchObject({ status: 0 });
  });

  it('keeps plain fetch semantics: an unreachable address is ApiError 0', async () => {
    // No driver set; nothing native in the test env, so the real fetch runs
    // against a port reserved for discarding — refusal, not a verdict.
    await expect(transport('http://127.0.0.1:9/api/health')).rejects.toMatchObject({ status: 0 });
  });
});
