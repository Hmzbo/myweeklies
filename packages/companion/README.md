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
