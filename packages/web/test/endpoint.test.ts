import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEndpoint, fetchExport, probeServer } from '../src/api.js';

const CONN = { url: 'http://h:1', token: 'tok' };

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('buildEndpoint', () => {
  it('prefixes and attaches the bearer only when native and configured', () => {
    expect(buildEndpoint('/api/x', CONN, true)).toEqual({
      url: 'http://h:1/api/x',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
    });
    // Stale key on PWA/desktop: same-origin, no bearer. Provably unchanged.
    expect(buildEndpoint('/api/x', CONN, false)).toEqual({
      url: '/api/x',
      headers: { 'content-type': 'application/json' },
    });
    expect(buildEndpoint('/api/x', null, true)).toEqual({
      url: '/api/x',
      headers: { 'content-type': 'application/json' },
    });
  });
});

describe('probeServer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns today from a healthy server', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ ok: true, today: '2026-10-09' }), { status: 200 }),
    );
    expect(await probeServer('http://h:1')).toBe('2026-10-09');
  });

  it('explains network failure actionably', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('down');
    });
    await expect(probeServer('http://h:1')).rejects.toMatchObject({ status: 0 });
  });

  it('rejects answers that are not a Takalif server', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    await expect(probeServer('http://h:1')).rejects.toThrow(/not a Takalif server/);
  });
});

describe('fetchExport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends base plus bearer on native, filename from the header', async () => {
    vi.stubGlobal('androidBridge', {});
    const store = fakeStorage();
    store.setItem('takalif-server', JSON.stringify(CONN));
    vi.stubGlobal('localStorage', store);
    let seen = { url: '', headers: {} as Record<string, string> };
    vi.stubGlobal(
      'fetch',
      async (url: string, init: { headers: Record<string, string> }) => {
        seen = { url, headers: init.headers };
        return new Response('a,b', {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="ledger.csv"',
            'content-type': 'text/csv',
          },
        });
      },
    );
    const file = await fetchExport('csv');
    expect(seen.url).toBe('http://h:1/api/export/csv');
    expect(seen.headers.authorization).toBe('Bearer tok');
    expect(file.filename).toBe('ledger.csv');
    expect(await file.blob.text()).toBe('a,b');
  });

  it('stays same-origin without a bearer when unconfigured', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    let seen = { url: '', headers: {} as Record<string, string> };
    vi.stubGlobal(
      'fetch',
      async (url: string, init: { headers: Record<string, string> }) => {
        seen = { url, headers: init.headers };
        return new Response('{}', { status: 200 });
      },
    );
    const file = await fetchExport('json');
    expect(seen.url).toBe('/api/export/json');
    expect(seen.headers.authorization).toBeUndefined();
    expect(file.filename).toBe('takalif-backup.json');
  });

  it('throws the server message on failure', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: 'nope' }), { status: 400 }),
    );
    await expect(fetchExport('ics')).rejects.toMatchObject({ status: 400, message: 'nope' });
  });
});
