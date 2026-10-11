import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.takalif.companion',
  appName: 'Takalif',
  // Built by @takalif/web: the exact UI the PWA serves, so the companion can
  // never drift from it. Run pnpm build first.
  webDir: '../web/dist',
  // The companion talks to a home server over plain LAN HTTP. HTTPS on a
  // residential LAN is out of reach, so cleartext stays on; the pairing
  // bearer token (not transport secrecy) is what protects the ledger.
  // Refine to per-domain config only if a deployment ever has TLS.
  android: {
    allowMixedContent: true,
  },
};

export default config;
