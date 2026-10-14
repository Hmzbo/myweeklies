# Takalif desktop (Tauri shell)

One-click app: a Tauri window around the same server + PWA the repo already
builds. No Docker, no terminal for the user.

## How it works

- The Tauri window loads `http://127.0.0.1:8787` served by a sidecar process.
- The sidecar is a **stock Node.js runtime** plus our bundles — no pkg/SEA
  single-file tricks, which is exactly where native modules (`better-sqlite3`)
  break. Boring and reliable beats clever here.
- Same-origin from the webview's point of view, so no CORS/origin changes,
  service worker works, all existing tests stay valid.

## Layout

```
packages/desktop/
  scripts/fetch-sidecar.mjs   assemble node + bundles into sidecar-build/
  sidecar-build/              assembled per-platform payload (gitignored)
    binaries/node-<triple>[.exe]
    resources/server/         index.js, schema.sql, node_modules/better-sqlite3
    resources/web/            built PWA
  src-tauri/                  Rust shell (window, sidecar spawn/kill, installer)
```

## Build (Windows)

```bash
pnpm build                                   # server bundle + web dist first
pnpm --filter @takalif/desktop fetch-sidecar
pnpm --filter @takalif/desktop bundle
```

`bundle` is deliberately not `build`: `pnpm -r build` must keep meaning
"all JS bundles" for CI, without needing Rust installed.

`fetch-sidecar` downloads the pinned Node runtime for `--triple` (default:
this machine), copies the bundles, and verifies the `better-sqlite3`
prebuild matches the sidecar's Node major. Other triples need their own
machine (native code cannot cross-compile) — that is what CI does.

Data lives in `%APPDATA%/com.takalif.desktop/takalif.sqlite`, never in the repo.

The HTTP listener stays loopback for the webview; a second, TLS listener
binds all interfaces so a paired phone reaches the server encrypted —
the pairing QR carries the certificate fingerprint the phone pins
(trust-on-first-use). Protection comes from the pairing bearer token,
and Windows Firewall still gates the port — Settings → Pair a device →
"Allow phones through the firewall" opens both ports with one consent.
Pair from Settings → Pair a device.

## Hacking on the shell

`cargo run` (or `cargo tauri dev`) resolves the sidecar binary from
`src-tauri/binaries/` but resources from the build output dir, so stage them
once after assembling:

```powershell
Copy-Item -Recurse -Force packages/desktop/sidecar-build/resources/server packages/desktop/src-tauri/target/debug/server
Copy-Item -Recurse -Force packages/desktop/sidecar-build/resources/web packages/desktop/src-tauri/target/debug/web
```

`target/` is gitignored. Release builds (`bundle`) need no staging: resources
travel inside the installers.
