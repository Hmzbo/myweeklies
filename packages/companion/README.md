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
- Camera QR scanning is the next slice; manual entry and paste work now.

## Build

Prerequisites: Android Studio (or command-line tools), JDK 17.

```bash
pnpm build                                          # web dist first
pnpm --filter @takalif/companion exec cap add android   # once
pnpm --filter @takalif/companion exec cap sync android  # after every web build
pnpm --filter @takalif/companion exec cap open android  # Android Studio
```

Debug APKs sideload freely (auto-signed); release needs a `keytool`
keystore. The manifest allows cleartext HTTP deliberately — see
`capacitor.config.ts`.
