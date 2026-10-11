import { useState } from 'react';
import { clearConnection, connectWithCode, setConnection, type ServerConnection } from '../connection.js';
import { probeServer } from '../api.js';
import { runMutation } from '../data.js';
import { Banner, Field } from '../ui.js';

/**
 * First-run gate for the companion: without a stored server connection there
 * is nothing to show, so connect first. Three paths in, easiest first —
 * pasting a scanned QR payload, then manual address + code. Never rendered in
 * the PWA or desktop shell (see the App gate).
 */
export function ConnectView({ onConnected }: { onConnected: () => void }) {
  const [code, setCode] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(store: () => ServerConnection) {
    setError(null);
    setBusy(true);
    const err = await runMutation(async () => {
      const conn = store();
      // Prove reachability before leaving: a well-formed but wrong address
      // must keep the user here with the error, not strand them in a dead app.
      try {
        await probeServer(conn.url);
      } catch (probeError) {
        clearConnection();
        throw probeError;
      }
      onConnected();
    });
    setBusy(false);
    if (err) setError(err.message);
  }

  return (
    <section aria-label="Connect to server">
      <h2 style={{ marginBlockEnd: '0.25rem' }}>Connect to your server</h2>
      <p className="muted" style={{ marginBlock: '0 1rem' }}>
        This app shows what your computer tracks. Open Settings → Pair a device
        there, then either paste the code below or enter the address and secret
        by hand.
      </p>
      {error && <Banner kind="error">{error}</Banner>}
      <Field
        label="Paste the pairing code"
        hint="The whole JSON text, exactly as shown under the QR code."
      >
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder='{"v":1,"url":"http://…","token":"…"}'
          rows={3}
          className="mono"
        />
      </Field>
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !code.trim()}
          onClick={() => void connect(() => connectWithCode(code))}
        >
          {busy ? 'Connecting…' : 'Connect with code'}
        </button>
      </div>
      <h3 className="section-title">Or enter manually</h3>
      <Field label="Server address" hint='Like http://192.168.100.43:8787 — no path after it.'>
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.100.43:8787"
        />
      </Field>
      <Field label="Secret code" hint="The long code shown under the QR code.">
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste the secret code"
        />
      </Field>
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          className="btn"
          disabled={busy || !url.trim() || !token.trim()}
          onClick={() => void connect(() => setConnection(url, token))}
        >
          {busy ? 'Connecting…' : 'Connect manually'}
        </button>
      </div>
    </section>
  );
}

/** Forget the stored server. Offered in Settings, only where one exists. */
export function DisconnectButton({ onDisconnected }: { onDisconnected: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="btn small" onClick={() => setConfirming(true)}>
        Disconnect from server
      </button>
    );
  }
  return (
    <span style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          clearConnection();
          onDisconnected();
        }}
      >
        Confirm disconnect
      </button>
      <button type="button" className="btn small ghost" onClick={() => setConfirming(false)}>
        Keep
      </button>
    </span>
  );
}
