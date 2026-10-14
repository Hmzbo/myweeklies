//! Desktop shell: spawns the Takalif server as a sidecar and shows it.
//!
//! The window loads `http://127.0.0.1:8787` from the sidecar, so from the
//! webview's point of view everything is same-origin localhost: no CORS or
//! origin changes, service worker works, existing tests stay valid.
//!
//! The sidecar itself binds all interfaces so a paired companion can reach it
//! over WiFi; the pairing bearer token is the protection there, not the bind.
//!
//! Lifecycle contract: the window stays hidden until the sidecar prints its
//! listening line (proving *our* child booted, not a stale occupant of the
//! port), with a timeout that shows it anyway. The child is killed on exit.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::sync::Mutex;
    use tauri::{Manager, RunEvent};

    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        // Plugins before setup: start_sidecar calls app.shell(), which
        // panics unless the shell plugin is already registered.
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch focuses the running window instead of orphaning
            // another server on the same port.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // Always registered (not debug-only): sidecar stdout/stderr relay
            // goes through these macros, and release needs them as much as dev
            // (Windows release has no console, but the macros stay correct and
            // a future file-target needs no code change).
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            start_sidecar(&app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // kill() is abrupt by necessity — Windows has no graceful
                // signal for a piped child — but SQLite WAL keeps every
                // committed transaction durable across it; only a write racing
                // the exit rolls back, and the user simply retries it.
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            log::info!("stopping sidecar");
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

struct SidecarState(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

const PORT: u16 = 8787;
/// Give up waiting for the listening line after this long; the window shows
/// anyway and the frontend's error banner explains how to retry.
const READY_TIMEOUT_SECS: u64 = 25;
const LISTENING_MARKER: &str = "Takalif server listening on";

/// Spawn the bundled Node runtime with the server bundle. All paths are
/// absolute and passed via env: the sidecar must not depend on any cwd.
fn start_sidecar(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_shell::ShellExt;

    let data_dir = app
        .path()
        .app_data_dir()
        .expect("app data dir must resolve");
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        log::error!("cannot create app data dir {}: {error}", data_dir.display());
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("resource dir must resolve");
    let server_entry = resource_dir.join("server").join("index.js");
    let web_dist = resource_dir.join("web");

    log::info!("sidecar entry: {}", server_entry.display());
    log::info!("sidecar web: {}", web_dist.display());
    log::info!("sidecar data: {}", data_dir.display());

    let window = app
        .get_webview_window("main")
        .expect("main window must exist");

    // Failsafe: never leave the user staring at nothing.
    std::thread::spawn({
        let window = window.clone();
        move || {
            std::thread::sleep(std::time::Duration::from_secs(READY_TIMEOUT_SECS));
            let _ = window.show();
        }
    });

    let spawned = app
        .shell()
        .sidecar("node")
        .map(|command| {
            command
                .args([server_entry.to_string_lossy().to_string()])
                .env("PORT", PORT.to_string())
                // Two listeners: HTTP stays loopback for the webview (same
                // origin, no CORS changes), and the TLS listener opens to the
                // LAN for paired companions (see server tls.ts). The pairing
                // bearer token, not the bind, is what protects the ledger —
                // Windows Firewall still gates the port.
                .env("HTTPS_HOST", "0.0.0.0")
                .env(
                    "DB_FILE",
                    data_dir.join("takalif.sqlite").to_string_lossy().to_string(),
                )
                .env("WEB_DIST", web_dist.to_string_lossy().to_string())
                // Die with the parent: a force-quit shell would otherwise
                // orphan the server holding the port. The server only honors
                // this flag; normal runs are unaffected.
                .env("TAKALIF_STDIN_EXIT", "1")
                .spawn()
        });

    let (mut rx, child) = match spawned {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => {
            log::error!("sidecar failed to spawn: {error}");
            let _ = window.show();
            return;
        }
        Err(error) => {
            log::error!("sidecar command rejected: {error}");
            let _ = window.show();
            return;
        }
    };
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
    }

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        // stdout may split a line across events; reassemble before matching.
        let mut pending: Vec<u8> = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    pending.extend_from_slice(&bytes);
                    while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                        let raw: Vec<u8> = pending.drain(..=end).collect();
                        let line = String::from_utf8_lossy(&raw);
                        log::info!(target: "takalif-sidecar", "{}", line.trim_end());
                        if line.contains(LISTENING_MARKER) {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    log::warn!(target: "takalif-sidecar", "{}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Error(error) => {
                    log::error!("sidecar error: {error}");
                    let _ = window.show();
                    break;
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("sidecar exited (code {:?}, signal {:?})", payload.code, payload.signal);
                    let _ = window.show();
                    break;
                }
                _ => {}
            }
        }
    });
}
