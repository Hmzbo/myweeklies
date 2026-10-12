import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { isLoopback, loadOrCreateToken, tokenFilePath } from './auth.js';
import { openDatabase } from './db.js';
import { pushConfigured, runReminderTick } from './reminders.js';
import { loadOrCreateKeystore } from './tls.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_FILE = process.env.DB_FILE ?? join(root, 'data', 'takalif.sqlite');
const WEB_DIST = process.env.WEB_DIST ?? join(root, 'packages', 'web', 'dist');
// Companion TLS listener. Off unless HTTPS_HOST is set: the desktop shell sets
// it (its own webview stays on loopback HTTP), plain servers keep serving the
// browser PWA over HTTP with the bearer token, unchanged.
const HTTPS_HOST = process.env.HTTPS_HOST ?? '';
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8788);

mkdirSync(dirname(DB_FILE), { recursive: true });

const db = openDatabase(DB_FILE);

// LAN pairing token: loopback callers never need it, but the moment the bind
// opens to the LAN every /api route (except /health) demands it as a bearer
// token. File-persisted next to the database so pairing survives restarts.
const tokenPinned = Boolean((process.env.TAKALIF_TOKEN ?? '').trim());
const authToken = loadOrCreateToken(dirname(DB_FILE), process.env.TAKALIF_TOKEN);

const pushConfig = {
  publicKey: process.env.VAPID_PUBLIC_KEY || undefined,
  privateKey: process.env.VAPID_PRIVATE_KEY || undefined,
  subject: process.env.VAPID_SUBJECT || undefined,
};

/**
 * Shared construction for both listeners. The HTTP one serves the browser PWA
 * and the desktop webview over loopback; the optional TLS one serves the
 * companion over the LAN with a self-signed certificate whose fingerprint the
 * QR carries, so the phone pins it (trust-on-first-use, see tls.ts).
 */
const tls = HTTPS_HOST
  ? await (async () => {
      const keystore = await loadOrCreateKeystore(dirname(DB_FILE));
      return {
        fingerprint: keystore.fingerprint,
        httpsPort: HTTPS_PORT,
        cert: keystore.certPem,
        key: keystore.keyPem,
      };
    })()
  : null;

const appOptions = (https: boolean) => ({
  // Same-origin only unless explicitly opened up. Reflecting any origin would
  // let any site the owner visits read and rewrite their ledger.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logger: process.env.LOG !== 'off',
  push: pushConfig,
  auth: { token: authToken, tokenDir: dirname(DB_FILE), pinned: tokenPinned },
  // Pairing info rides on both instances; key/cert go to the LAN one alone.
  tls: tls
    ? https
      ? { fingerprint: tls.fingerprint, httpsPort: tls.httpsPort, key: tls.key, cert: tls.cert }
      : { fingerprint: tls.fingerprint, httpsPort: tls.httpsPort }
    : undefined,
});

const app = buildApp(db, appOptions(false));

if (existsSync(join(WEB_DIST, 'index.html'))) {
  // Serve the built PWA when it is available, so one process is the whole app.
  // Gated on index.html rather than the directory: without it, `sendFile`
  // re-enters the not-found handler and turns every request into a 500.
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: WEB_DIST });
}
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  // Client-side routing: hand back the SPA shell, but only to requests that
  // actually want a document.
  if (!req.headers.accept?.includes('text/html')) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  if (reply.sent) return;
  reply.sendFile('index.html');
});

// Companion TLS listener. API-only: a browser pointed here hits the
// certificate warning by design — phones do not, they pin the fingerprint.
let lanApp: ReturnType<typeof buildApp> | null = null;
if (tls) {
  lanApp = buildApp(db, appOptions(true));
  lanApp.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });
}

await app.listen({ port: PORT, host: HOST });

if (lanApp) {
  await lanApp.listen({ port: HTTPS_PORT, host: HTTPS_HOST });
}

console.log(`Takalif server listening on http://${HOST}:${PORT}`);
if (lanApp) {
  console.log(`  LAN TLS:  https://${HTTPS_HOST}:${HTTPS_PORT} (cert fingerprint ${tls!.fingerprint})`);
}
console.log(`  database: ${DB_FILE}`);
if ((HOST !== 'localhost' && !isLoopback(HOST)) || (lanApp && !isLoopback(HTTPS_HOST))) {
  // Deliberately printed: a headless LAN server is otherwise unpairable, and
  // the token file is root-readable on a single-user machine anyway.
  console.log(`  LAN API auth on; pairing token: ${authToken} (${tokenFilePath(dirname(DB_FILE))})`);
}
if (existsSync(WEB_DIST)) console.log(`  web:      ${WEB_DIST}`);
if (pushConfigured(pushConfig)) {
  console.log('  reminders: web push enabled');
} else {
  console.log('  reminders: web push disabled (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)');
}

// Reminders must be server-side: the client is not reliably open, and the
// ledger is the source of truth. One pass a minute is plenty — reminder times
// have minute resolution, and each pass marks what it sent.
const REMINDER_INTERVAL_MS = 60_000;
async function reminderTick(): Promise<void> {
  try {
    const result = await runReminderTick(db, pushConfig, new Date());
    if (result.checked > 0) {
      console.log(
        `reminders: checked ${result.checked}, sent ${result.sent}, failed ${result.failed}, pruned ${result.pruned}`,
      );
    }
  } catch (error) {
    // A failed tick must never take the server down with it.
    console.error('reminders: tick failed', error);
  }
}
await reminderTick();
const reminderTimer = setInterval(() => {
  void reminderTick();
}, REMINDER_INTERVAL_MS);

let exiting = false;
/** Stop serving, checkpoint the database, and leave. First caller wins. */
function gracefulExit(): void {
  if (exiting) return;
  exiting = true;
  clearInterval(reminderTimer);
  void app
    .close()
    .catch(() => undefined)
    .then(() => (lanApp ? lanApp.close().catch(() => undefined) : undefined))
    .then(() => {
      try {
        db.close();
      } catch {
        // Already closed by a racing path; exit anyway.
      }
      process.exit(0);
    });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, gracefulExit);
}

// Opt-in orphan guard for launcher shells (Tauri sidecar sets it): when the
// parent dies without asking us to stop, our stdin closes. A force-quit shell
// would otherwise orphan the server holding the port, and the next launch
// would find its port taken by a stale process. Normal runs (Docker, dev)
// never set the flag and are unaffected.
if (process.env.TAKALIF_STDIN_EXIT === '1') {
  process.stdin.resume();
  process.stdin.on('end', gracefulExit);
  process.stdin.on('close', gracefulExit);
}
