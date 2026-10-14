# Takalif companion (Android)

The same PWA UI in a native shell, paired to a home server over LAN. No
browser flags, no Tailscale: a WebView has no PWA installability rules to
satisfy. Reminders travel over the existing ntfy channel — no native
notification code in v1.

## How it works

- First launch shows a Connect screen (paste the pairing code from the
  desktop's Settings → Pair a device, or enter address + secret by hand).
- The stored server URL + bearer token prefix every API call (`connection.ts`
  in `@takalif/web`; dormant in PWA/desktop builds).
- Camera QR scanning (system scanner UI), pasting a scanned payload, and
  manual entry all work.

## WebView scheme

The shell serves its UI at `http://localhost` (`server.androidScheme`, not
Capacitor's `https` default). The companion fetches plain-HTTP LAN addresses,
and an `https` page doing that is mixed content, which the WebView blocks —
that failed as "Cannot reach" for addresses a phone browser opens fine.
`localhost` stays a secure context over http, so the service worker is
unaffected, and the server already allowlists `http://localhost` as a
companion origin. Switching schemes begins a fresh localStorage: an installed
app pairs once more.

## Pinned HTTP transport

Every `/api` call in the companion rides a native OkHttp channel
(`PinnedHttpPlugin.java`), not the WebView network stack. The WebView cannot
pin certificates; the pairing QR can contain the SHA-256 of the server's
TLS certificate, and the phone refuses any handshake whose leaf does not
match it — trust-on-first-use, the trust anchor travelling by camera rather
than over the wire. Without a pin (v1 http pairings), plain cleartext goes
through, per the pairing contract's own rules. Hostname verification is
deliberately off: the server answers an IP, the fingerprint is the identity.

Pin mismatches surface as a re-pair message and are never swallowed by the
offline queue — a server answering with the wrong certificate is not (only)
the server the user paired.

## Build

Prerequisites: Android command-line tools (or Studio), JDK 21.

Scanner plugin versions must stay identical in `packages/web` and
`packages/companion` (both pinned exact): the APK bakes the native side
while the UI floats with the web bundle, and skew breaks the bridge.

```bash
pnpm build                                          # web dist first
pnpm --filter @takalif/companion exec cap add android   # once
pnpm --filter @takalif/companion exec cap sync android  # after every web build
pnpm --filter @takalif/companion exec cap open android  # Android Studio
```

Debug APKs sideload freely (auto-signed); release needs a `keytool`
keystore. The manifest allows cleartext HTTP deliberately — see
`capacitor.config.ts`.
