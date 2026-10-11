import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bearerToken, isLoopback, lanIPv4, loadOrCreateToken, pickPairingInterfaces } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { openDatabase, type DB } from '../src/db.js';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'test-token-for-lan-pairing';

describe('isLoopback', () => {
  it('accepts loopback in all common spellings', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.0.0.2')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback('192.168.1.5')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('::')).toBe(false);
    expect(isLoopback('not-an-ip')).toBe(false);
    // Hostnames and non-decimal forms never come out of request.ip.
    expect(isLoopback('localhost')).toBe(false);
    expect(isLoopback('0x7f.0.0.1')).toBe(false);
    expect(isLoopback('127.1')).toBe(false);
    expect(isLoopback('127.0.0.1 ')).toBe(false);
    expect(isLoopback('0127.0.0.1')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('parses the Authorization header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBeNull();
    expect(bearerToken('Token abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
  });
});

describe('loadOrCreateToken', () => {
  it('prefers the environment value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-token-'));
    try {
      expect(loadOrCreateToken(dir, '  env-token  ')).toBe('env-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a generated token across calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-token-'));
    try {
      const first = loadOrCreateToken(dir);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(loadOrCreateToken(dir)).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lanIPv4', () => {
  it('returns an IPv4 string or null, never throws', () => {
    const ip = lanIPv4();
    expect(ip === null || /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)).toBe(true);
  });
});

describe('pickPairingInterfaces', () => {
  const nic = (family: string, internal: boolean, address: string) => ({
    family,
    internal,
    address,
  });

  it('ranks RFC 1918 first and drops internal and non-IPv4', () => {
    const picked = pickPairingInterfaces({
      Tailscale: [nic('IPv4', false, '100.88.254.127')],
      Ethernet: [nic('IPv4', false, '192.168.100.43')],
      Loopback: [nic('IPv4', true, '127.0.0.1'), nic('IPv6', false, 'fe80::1')],
    });
    expect(picked).toEqual([
      { name: 'Ethernet', address: '192.168.100.43' },
      { name: 'Tailscale', address: '100.88.254.127' },
    ]);
  });

  it('ranks virtual switches below physical NICs on the same private range', () => {
    const picked = pickPairingInterfaces({
      'vEthernet (WSL (Hyper-V firewall))': [nic('IPv4', false, '172.19.240.1')],
      Ethernet: [nic('IPv4', false, '192.168.100.43')],
      Tailscale: [nic('IPv4', false, '100.88.254.127')],
    });
    expect(picked.map((n) => n.address)).toEqual([
      '192.168.100.43',
      '172.19.240.1',
      '100.88.254.127',
    ]);
  });

  it('returns an empty list when nothing is usable', () => {
    expect(pickPairingInterfaces({ lo: [nic('IPv4', true, '127.0.0.1')] })).toEqual([]);
    expect(pickPairingInterfaces({})).toEqual([]);
  });
});

describe('LAN token enforcement', () => {
  const REMOTE = '192.168.1.5';
  let dir: string;
  let db: DB;
  let app: FastifyInstance;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'takalif-auth-'));
    db = openDatabase(join(dir, 'test.sqlite'));
    app = buildApp(db, { logger: false, auth: { token: TOKEN, tokenDir: dir } });
  };
  const teardown = () => {
    void app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const lan = (method: string, url: string, token?: string) =>
    app.inject({
      method: method as 'GET',
      url,
      remoteAddress: REMOTE,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  it('leaves loopback fully open without a token', async () => {
    setup();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/rules' });
      expect(res.statusCode).toBe(200);
    } finally {
      teardown();
    }
  });

  it('refuses LAN callers without or with a wrong token', async () => {
    setup();
    try {
      expect((await lan('GET', '/api/rules')).statusCode).toBe(401);
      expect((await lan('GET', '/api/rules', 'wrong')).statusCode).toBe(401);
      expect((await lan('POST', '/api/rules', 'wrong')).statusCode).toBe(401);
    } finally {
      teardown();
    }
  });

  it('a refused LAN write leaves no trace', async () => {
    setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        remoteAddress: REMOTE,
        payload: JSON.stringify({ title: 'Evil', rrule: 'FREQ=DAILY' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(401);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      teardown();
    }
  });

  it('admits LAN callers presenting the token', async () => {
    setup();
    try {
      const res = await lan('GET', '/api/rules', TOKEN);
      expect(res.statusCode).toBe(200);
    } finally {
      teardown();
    }
  });

  it('keeps /api/health open on the LAN for managers and probes', async () => {
    setup();
    try {
      expect((await lan('GET', '/api/health')).statusCode).toBe(200);
      expect((await lan('GET', '/api/health?probe=1')).statusCode).toBe(200);
    } finally {
      teardown();
    }
  });

  it('serves pairing details on loopback only', async () => {
    setup();
    try {
      const local = await app.inject({ method: 'GET', url: '/api/pairing' });
      expect(local.statusCode).toBe(200);
      const doc = JSON.parse(local.body);
      expect(doc.token).toBe(TOKEN);
      expect(Array.isArray(doc.interfaces)).toBe(true);
      for (const nic of doc.interfaces) {
        expect(typeof nic.name).toBe('string');
        expect(nic.address).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
      }

      const remote = await lan('GET', '/api/pairing', TOKEN);
      expect(remote.statusCode).toBe(403);
    } finally {
      teardown();
    }
  });

  it('answers 400 for pairing when no token is configured', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'takalif-auth-'));
    const plainDb = openDatabase(join(plainDir, 'test.sqlite'));
    const plainApp = buildApp(plainDb, { logger: false });
    try {
      const res = await plainApp.inject({ method: 'GET', url: '/api/pairing' });
      expect(res.statusCode).toBe(400);
      const rotated = await plainApp.inject({ method: 'POST', url: '/api/pairing/rotate' });
      expect(rotated.statusCode).toBe(400);
    } finally {
      void plainApp.close();
      plainDb.close();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('rotation hands out a new code and kills the old one', async () => {
    setup();
    try {
      const rotated = await app.inject({ method: 'POST', url: '/api/pairing/rotate' });
      expect(rotated.statusCode).toBe(200);
      const fresh = JSON.parse(rotated.body).token as string;
      expect(fresh).toMatch(/^[0-9a-f]{64}$/);
      expect(fresh).not.toBe(TOKEN);

      // The persisted file agrees, so the new code survives a restart.
      expect(loadOrCreateToken(dir)).toBe(fresh);

      // Old code refused everywhere, new code admitted.
      expect((await lan('GET', '/api/rules', TOKEN)).statusCode).toBe(401);
      expect((await lan('GET', '/api/rules', fresh)).statusCode).toBe(200);
    } finally {
      teardown();
    }
  });

  it('rotation is loopback-only', async () => {
    setup();
    try {
      const remote = await lan('POST', '/api/pairing/rotate', TOKEN);
      expect(remote.statusCode).toBe(403);
    } finally {
      teardown();
    }
  });

  it('admits a bearer call from a companion WebView origin', async () => {
    setup();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/rules',
        remoteAddress: REMOTE,
        headers: { origin: 'capacitor://localhost', authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      teardown();
    }
  });

  it('answers preflight from a companion WebView origin', async () => {
    setup();
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/rules',
        remoteAddress: REMOTE,
        headers: {
          origin: 'http://localhost',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost');
    } finally {
      teardown();
    }
  });

  it('still refuses an unknown browser origin without a bearer', async () => {
    setup();
    try {
      // No bearer on the LAN: the token boundary answers first.
      const remote = await app.inject({
        method: 'GET',
        url: '/api/rules',
        remoteAddress: REMOTE,
        headers: { origin: 'https://evil.example' },
      });
      expect(remote.statusCode).toBe(401);
      // An evil Origin over loopback reaches the origin guard instead.
      const local = await app.inject({
        method: 'GET',
        url: '/api/rules',
        headers: { origin: 'https://evil.example' },
      });
      expect(local.statusCode).toBe(403);
    } finally {
      teardown();
    }
  });

  it('rotation is refused while the token is pinned by env', async () => {
    const pinnedDir = mkdtempSync(join(tmpdir(), 'takalif-auth-'));
    const pinnedDb = openDatabase(join(pinnedDir, 'test.sqlite'));
    const pinnedApp = buildApp(pinnedDb, {
      logger: false,
      auth: { token: TOKEN, tokenDir: pinnedDir, pinned: true },
    });
    try {
      const res = await pinnedApp.inject({ method: 'POST', url: '/api/pairing/rotate' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toMatch(/TAKALIF_TOKEN/);
      // And the pinned code still works — nothing was touched.
      expect(
        (
          await pinnedApp.inject({
            method: 'GET',
            url: '/api/rules',
            remoteAddress: '192.168.1.5',
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      void pinnedApp.close();
      pinnedDb.close();
      rmSync(pinnedDir, { recursive: true, force: true });
    }
  });
});
