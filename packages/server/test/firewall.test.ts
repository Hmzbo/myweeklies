import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { firewallScript, mapFirewallOutcome } from '../src/firewall.js';
import { openDatabase, type DB } from '../src/db.js';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'firewall-test-token';
const REMOTE = '192.168.1.5';

describe('firewall script', () => {
  it('is a reviewable PS one-liner that checks the rule unprivileged', () => {
    const script = firewallScript();
    expect(script).toContain("Get-NetFirewallRule -DisplayName $n");
    expect(script).toContain('Start-Process netsh -Verb RunAs -Wait');
    expect(script).toContain('protocol=TCP');
    expect(script).toContain('localport=8787-8788');
    // The rule name is quoted; no second unquoted bareword sneaks out.
    expect(script).toContain('name="Takalif companion (8787-8788)"');
  });

  it('maps exit codes to button outcomes', () => {
    expect(mapFirewallOutcome({ code: 0, stderr: '' })).toMatchObject({ status: 'opened' });
    expect(mapFirewallOutcome({ code: 2, stderr: '' })).toMatchObject({ status: 'already' });
    expect(
      mapFirewallOutcome({ code: 1, stderr: 'Thisoperation was canceled by the user' }),
    ).toMatchObject({ status: 'declined' });
    expect(
      mapFirewallOutcome({ code: 1, stderr: 'Some netsh failure' }),
    ).toMatchObject({ status: 'failed', message: 'Some netsh failure' });
  });
});

describe('firewall consent route', () => {
  let dir: string;
  let db: DB;
  let app: FastifyInstance;
  let executions: string[];

  const setup = (opts: { windows: boolean }) => {
    dir = mkdtempSync(join(tmpdir(), 'takalif-fw-'));
    db = openDatabase(join(dir, 'test.sqlite'));
    executions = [];
    app = buildApp(db, {
      logger: false,
      auth: { token: TOKEN, tokenDir: dir },
      windows: opts.windows,
      firewallExecutor: async (script) => {
        executions.push(script);
        return { code: 0, stderr: '' };
      },
    });
  };
  const teardown = () => {
    void app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const call = (remoteAddress?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/pairing/firewall',
      ...(remoteAddress
        ? { remoteAddress }
        : { headers: { authorization: `Bearer ${TOKEN}` } }),
    });

  it('runs the script from loopback with a token', async () => {
    setup({ windows: true });
    try {
      const res = await call();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'opened' });
      expect(executions).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it('refuses remote callers, whatever they carry', async () => {
    setup({ windows: true });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/pairing/firewall',
        remoteAddress: REMOTE,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
      expect(executions).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('answers unsupported off Windows, so no one reaches for netsh', async () => {
    setup({ windows: false });
    try {
      const res = await call();
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.stringContaining('Windows-only') });
      expect(executions).toHaveLength(0);
    } finally {
      teardown();
    }
  });
});
