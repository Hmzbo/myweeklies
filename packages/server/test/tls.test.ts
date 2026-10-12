import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase, type DB } from '../src/db.js';
import { loadOrCreateKeystore, pemToDer } from '../src/tls.js';

describe('keystore', () => {
  it('generates once and persists: the fingerprint is stable across calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-tls-'));
    try {
      const first = await loadOrCreateKeystore(dir);
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(first.certPem).toContain('-----BEGIN CERTIFICATE-----');
      const second = await loadOrCreateKeystore(dir);
      // A fingerprint change strands every paired companion with a pin
      // failure: persistence is the contract under test here.
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.certPem).toBe(first.certPem);
      expect(second.keyPem).toBe(first.keyPem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores a fingerprint on disk that matches the QR formula', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-tls-'));
    try {
      const keystore = await loadOrCreateKeystore(dir);
      const doc = JSON.parse(
        readFileSync(join(dir, 'takalif-https.json'), 'utf8'),
      ) as { fingerprint: string };
      expect(doc.fingerprint).toBe(keystore.fingerprint);
      // Recompute the contract independently: SHA-256 of the cert DER bytes.
      const recomputed = createHash('sha256').update(pemToDer(keystore.certPem)).digest('hex');
      expect(keystore.fingerprint).toBe(recomputed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regenerates over a corrupt keystore instead of serving garbage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-tls-'));
    try {
      const fresh = await loadOrCreateKeystore(dir);
      // A truncated or tampered file must not serve TLS under a fingerprint
      // nobody knows: fall back to minting a fresh, consistent identity.
      writeFileSync(join(dir, 'takalif-https.json'), '{not json', 'utf8');
      const regenerated = await loadOrCreateKeystore(dir);
      expect(regenerated.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(regenerated.fingerprint).not.toBe(fresh.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Live TLS: a full HTTPS listener, a handshake trusted by the very
 * certificate it serves, and the pairing fields the QR builds from.
 * Self-signed leaf certs carry CA:TRUE, so trusting the leaf as its own CA
 * validates the chain — exactly what the companion pin will compare against.
 */
describe('LAN TLS listener', () => {
  it('serves /api/health and pairing info over TLS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-tls-'));
    let db: DB | null = null;
    try {
      const keystore = await loadOrCreateKeystore(dir);
      db = openDatabase(join(dir, 'test.sqlite'));
      const app = buildApp(db, {
        logger: false,
        auth: { token: 'tls-test-token', tokenDir: dir },
        tls: {
          fingerprint: keystore.fingerprint,
          httpsPort: 9843,
          key: keystore.keyPem,
          cert: keystore.certPem,
        },
      });
      await app.listen({ port: 9843, host: '127.0.0.1' });
      try {
        const { default: https } = await import('node:https');
        // The companion's trust model, mirrored: identity is the pinned
        // fingerprint, not the hostname (the server answers an IP; hostnames
        // on a LAN are fiction). So the test agent verifies the CA and skips
        // checkServerIdentity, exactly what the client pin will do.
        const mirrorCompanion = {
          ca: keystore.certPem,
          checkServerIdentity: (): undefined => undefined,
        };
        const trusted = new https.Agent(mirrorCompanion);

        const get = (path: string) =>
          new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = https.request(
              `https://127.0.0.1:9843${path}`,
              { agent: trusted, headers: { authorization: 'Bearer tls-test-token' } },
              (res) => {
                let out = '';
                res.on('data', (chunk) => (out += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
              },
            );
            req.on('error', reject);
            req.end();
          });

        const health = await get('/api/health');
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toMatchObject({ ok: true });

        const pairing = await get('/api/pairing');
        expect(pairing.status).toBe(200);
        const doc = JSON.parse(pairing.body) as {
          fingerprint: string | null;
          httpsPort: number | null;
          token: string;
        };
        expect(doc.fingerprint).toBe(keystore.fingerprint);
        expect(doc.httpsPort).toBe(9843);
        expect(doc.token).toBe('tls-test-token');

        // A certificate that did not sign this server's key must fail the
        // handshake: the companion will compare fingerprints the same way.
        const other = await loadOrCreateKeystore(mkdtempSync(join(tmpdir(), 'takalif-tls-')));
        const distrust = new https.Agent({
          ca: other.certPem,
          checkServerIdentity: (): undefined => undefined,
        });
        const rejected = await new Promise<boolean>((resolve) => {
          const req = https.request(
            'https://127.0.0.1:9843/api/health',
            { agent: distrust },
            (res) => {
              res.resume();
              resolve(false); // handshake succeeded — wrong isolation
            },
          );
          req.on('error', () => resolve(true));
          req.end();
        });
        expect(rejected).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports pairing TLS fields as null without a TLS config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-auth-'));
    let db: DB | null = null;
    try {
      db = openDatabase(join(dir, 'test.sqlite'));
      const app = buildApp(db, {
        logger: false,
        auth: { token: 'plain-token', tokenDir: dir },
      });
      const res = await app.inject({ method: 'GET', url: '/api/pairing' });
      expect(res.statusCode).toBe(200);
      const doc = JSON.parse(res.body) as { fingerprint: string | null; httpsPort: number | null };
      expect(doc.fingerprint).toBeNull();
      expect(doc.httpsPort).toBeNull();
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
