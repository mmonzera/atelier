//! Atelier desktop shell (Tauri).
//!
//! A thin native shell around the Node server ("sidecar"): it starts the server on a dynamic
//! loopback port, points the window at it, and adds tray, native notifications, single-instance
//! and auto-update. All app logic stays in the TypeScript server and web UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos_audio;
mod meeting_audio;
mod meeting_detect;

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    quitting: AtomicBool,
    hint_shown: AtomicBool,
    /// Meeting audio being recorded (at most one meeting at a time).
    recorder: Mutex<Option<meeting_audio::Recorder>>,
    /// Level meter shown in Settings while the user picks a microphone.
    meter: Mutex<Option<meeting_audio::Meter>>,
    /// Serialises start/stop requests so a stop never overtakes a start that is still opening devices.
    audio_ops: Mutex<()>,
    /// Watch for Zoom / Teams / browser meetings; the server switches it from Settings.
    detect: Arc<AtomicBool>,
}

impl Sidecar {
    fn send(&self, line: &str) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{line}");
            let _ = stdin.flush();
        }
    }
}

/// A line sender to the server for background threads (audio capture, meeting detection).
fn server_out(app: &AppHandle) -> meeting_audio::Out {
    let app = app.clone();
    Arc::new(move |line: String| app.state::<Sidecar>().send(&line))
}

/// The microphone / speaker the user picked (`null` = follow the Windows defaults).
fn devices_from(v: &serde_json::Value) -> meeting_audio::Devices {
    let pick = |key: &str| v[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    meeting_audio::Devices { mic: pick("micDevice"), speaker: pick("speakerDevice") }
}

/// `ATELIER_AUDIO {"action":"start"|"stop",…}` from the server. Runs off the stdout reader
/// thread because opening devices and flushing the last chunk take a moment.
fn handle_audio(app: &AppHandle, v: serde_json::Value) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<Sidecar>();
        let _serial = state.audio_ops.lock().unwrap();
        let id = v["meetingId"].as_str().unwrap_or_default().to_string();
        match v["action"].as_str() {
            Some("start") => {
                let previous = state.recorder.lock().unwrap().take();
                if let Some(rec) = previous {
                    rec.stop();
                }
                let dir = PathBuf::from(v["dir"].as_str().unwrap_or_default());
                let devices = devices_from(&v);
                match meeting_audio::Recorder::start(id.clone(), dir, server_out(&app), devices) {
                    Ok((rec, warnings)) => {
                        *state.recorder.lock().unwrap() = Some(rec);
                        state.send(&format!("audio-started {}", json!({ "meetingId": id })));
                        for message in warnings {
                            state.send(&format!(
                                "audio-error {}",
                                json!({ "meetingId": id, "message": message, "fatal": false })
                            ));
                        }
                    }
                    Err(message) => state.send(&format!(
                        "audio-error {}",
                        json!({ "meetingId": id, "message": message, "fatal": true })
                    )),
                }
            }
            Some("stop") => {
                let rec = {
                    let mut guard = state.recorder.lock().unwrap();
                    if guard.as_ref().is_some_and(|r| id.is_empty() || r.meeting_id == id) {
                        guard.take()
                    } else {
                        None
                    }
                };
                if let Some(rec) = rec {
                    rec.stop();
                }
                state.send(&format!("audio-stopped {}", json!({ "meetingId": id })));
            }
            Some("list-devices") => {
                let request_id = v["requestId"].as_str().unwrap_or_default().to_string();
                let mut devices = meeting_audio::list_devices();
                devices["requestId"] = json!(request_id);
                state.send(&format!("audio-devices {devices}"));
            }
            Some("meter") => {
                // Replace a running meter; `enabled: false` only stops it.
                let previous = state.meter.lock().unwrap().take();
                if let Some(m) = previous {
                    m.stop();
                }
                if v["enabled"].as_bool().unwrap_or(false) {
                    let meter = meeting_audio::Meter::start(devices_from(&v), server_out(&app));
                    *state.meter.lock().unwrap() = Some(meter);
                }
            }
            Some(action @ ("pause" | "resume")) => {
                if let Some(rec) = state.recorder.lock().unwrap().as_ref() {
                    if id.is_empty() || rec.meeting_id == id {
                        rec.set_paused(action == "pause");
                    }
                }
            }
            _ => {}
        }
    });
}

fn data_root() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir());
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
        .unwrap_or_else(|| std::env::temp_dir());
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
        .unwrap_or_else(|| std::env::temp_dir());
    base.join("Atelier")
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default()
}

/// Bundled Node runtime next to the app exe; falls back to `node` on PATH for dev runs.
fn node_path() -> PathBuf {
    #[cfg(windows)]
    let binary_name = "atelier-node.exe";
    #[cfg(not(windows))]
    let binary_name = "atelier-node";

    let bundled = exe_dir().join(binary_name);
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

fn server_dir() -> PathBuf {
    let direct = exe_dir().join("server");
    if direct.exists() {
        return direct;
    }
    let macos_resources = exe_dir().join("../Resources/server");
    if macos_resources.exists() {
        return macos_resources;
    }
    direct
}

fn server_command(extra_arg: Option<&str>) -> Command {
    let root = data_root();
    let data = std::env::var_os("ATELIER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("data"));
    let workspaces = std::env::var_os("ATELIER_WORKSPACES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("workspaces"));
    let _ = fs::create_dir_all(&data);
    let _ = fs::create_dir_all(&workspaces);

    let mut cmd = Command::new(node_path());
    cmd.arg("--disable-warning=ExperimentalWarning")
        .arg(server_dir().join("server.mjs"));
    if let Some(arg) = extra_arg {
        cmd.arg(arg);
    }
    cmd.current_dir(&root)
        .env("ATELIER_EMBEDDED", "1")
        .env("ATELIER_DATA_DIR", data)
        .env("ATELIER_WORKSPACES_DIR", workspaces)
        .env("ATELIER_WEB_DIST", server_dir().join("web"))
        .env("ATELIER_APP_VERSION", env!("CARGO_PKG_VERSION"));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn message_box(text: &str) {
    #[cfg(windows)]
    {
        let script = format!(
            "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('{}','Atelier')",
            text.replace('\'', "''")
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-Command", &script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display dialog \"{}\" with title \"Atelier\" buttons {{\"OK\"}} default button \"OK\"",
            text.replace('"', "\\\"")
        );
        let _ = Command::new("osascript").args(["-e", &script]).status();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    eprintln!("{text}");
}

/// Tells the page when it is tucked into / restored from the tray so decorative animations sleep.
fn tell_page(win: &tauri::WebviewWindow, hidden: bool) {
    let name = if hidden { "atelier-shell-hidden" } else { "atelier-shell-shown" };
    let _ = win.eval(format!("window.dispatchEvent(new Event('{name}'))"));
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        tell_page(&win, false);
    }
}

fn notify(app: &AppHandle, title: &str, body: &str, only_if_unfocused: bool) {
    if only_if_unfocused {
        if let Some(win) = app.get_webview_window("main") {
            if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
                return;
            }
        }
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

fn start_server(app: &AppHandle) -> Result<(), String> {
    let log_dir = data_root().join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("server.log"))
        .map_err(|e| e.to_string())?;

    let mut child = server_command(None)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("Gagal menjalankan server ({}): {e}", node_path().display()))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let state = app.state::<Sidecar>();
    *state.stdin.lock().unwrap() = child.stdin.take();
    *state.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("ATELIER_READY ") {
                let port = serde_json::from_str::<serde_json::Value>(rest)
                    .ok()
                    .and_then(|v| v["port"].as_u64());
                if let (Some(port), Some(win)) = (port, handle.get_webview_window("main")) {
                    if let Ok(url) = format!("http://127.0.0.1:{port}/").parse() {
                        let _ = win.navigate(url);
                    }
                }
            } else if let Some(rest) = line.strip_prefix("ATELIER_NOTIFY ") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    notify(
                        &handle,
                        v["title"].as_str().unwrap_or("Atelier"),
                        v["body"].as_str().unwrap_or(""),
                        true,
                    );
                }
            } else if let Some(rest) = line.strip_prefix("ATELIER_AUDIO ") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    handle_audio(&handle, v);
                }
            } else if let Some(rest) = line.strip_prefix("ATELIER_DETECT ") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    let on = v["enabled"].as_bool().unwrap_or(false);
                    handle.state::<Sidecar>().detect.store(on, Ordering::SeqCst);
                }
            } else if let Some(rest) = line.strip_prefix("ATELIER_UPDATE ") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    match v["action"].as_str() {
                        Some("check") => {
                            let h = handle.clone();
                            tauri::async_runtime::spawn(check_update(h, false));
                        }
                        Some("install") => {
                            let h = handle.clone();
                            tauri::async_runtime::spawn(check_update(h, true));
                        }
                        _ => {}
                    }
                }
            }
        }
        // No server to send chunks to any more: stop recording (written files are adopted on restart).
        let state = handle.state::<Sidecar>();
        state.detect.store(false, Ordering::SeqCst);
        let recorder = state.recorder.lock().unwrap().take();
        if let Some(rec) = recorder {
            rec.stop();
        }
        let meter = state.meter.lock().unwrap().take();
        if let Some(m) = meter {
            m.stop();
        }
        // Server exited on its own (crash): tell the user instead of leaving a blank window.
        if !handle.state::<Sidecar>().quitting.load(Ordering::SeqCst) {
            notify(
                &handle,
                "Atelier server berhenti",
                "Server lokal tidak berjalan. Lihat logs\\server.log di folder data, lalu buka ulang Atelier.",
                false,
            );
        }
    });
    Ok(())
}

/// Graceful stop: the server finishes agent turns, runs backup-on-close and closes SQLite.
fn quit(app: &AppHandle) {
    let state = app.state::<Sidecar>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.send("shutdown");
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<Sidecar>();
        let deadline = Instant::now() + Duration::from_secs(22);
        loop {
            let done = match state.child.lock().unwrap().as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            };
            if done {
                break;
            }
            if Instant::now() >= deadline {
                if let Some(child) = state.child.lock().unwrap().as_mut() {
                    let _ = child.kill();
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        app.exit(0);
    });
}

fn send_update_status(app: &AppHandle, payload: serde_json::Value) {
    app.state::<Sidecar>().send(&format!("update-status {payload}"));
}

async fn check_update(app: AppHandle, install: bool) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            send_update_status(&app, json!({ "state": "error", "error": e.to_string() }));
            return;
        }
    };
    if !install {
        send_update_status(&app, json!({ "state": "checking", "error": serde_json::Value::Null }));
    }
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            if install {
                send_update_status(
                    &app,
                    json!({
                        "state": "downloading",
                        "availableVersion": version,
                        "notes": notes,
                        "progressPercent": 0,
                        "error": serde_json::Value::Null
                    }),
                );
                notify(&app, "Mengunduh update Atelier", &format!("Versi {}…", version), false);
                let app_prog = app.clone();
                let ver_prog = version.clone();
                let app_done = app.clone();
                let mut downloaded: u64 = 0;
                let mut last_pct: i64 = -1;
                // On Windows the NSIS passive installer takes over and restarts the app after finish.
                let res = update
                    .download_and_install(
                        move |chunk_length, content_length| {
                            downloaded = downloaded.saturating_add(chunk_length as u64);
                            if let Some(total) = content_length {
                                if total > 0 {
                                    let pct = ((downloaded.saturating_mul(100)) / total).min(100) as i64;
                                    if pct >= last_pct + 5 || pct == 100 {
                                        last_pct = pct;
                                        send_update_status(
                                            &app_prog,
                                            json!({
                                                "state": "downloading",
                                                "availableVersion": ver_prog,
                                                "progressPercent": pct
                                            }),
                                        );
                                    }
                                }
                            }
                        },
                        move || {
                            app_done.state::<Sidecar>().send("shutdown");
                        },
                    )
                    .await;
                if let Err(e) = res {
                    send_update_status(
                        &app,
                        json!({
                            "state": "error",
                            "availableVersion": version,
                            "progressPercent": serde_json::Value::Null,
                            "error": e.to_string()
                        }),
                    );
                    notify(&app, "Update gagal", "Coba lagi dari aplikasi atau menu tray.", false);
                }
            } else {
                send_update_status(
                    &app,
                    json!({
                        "state": "available",
                        "availableVersion": version,
                        "notes": notes,
                        "progressPercent": serde_json::Value::Null,
                        "error": serde_json::Value::Null
                    }),
                );
                notify(
                    &app,
                    "Update Atelier tersedia",
                    &format!("Versi {} siap. Klik Update di dalam Atelier atau tray.", version),
                    false,
                );
            }
        }
        Ok(None) => {
            send_update_status(
                &app,
                json!({
                    "state": "up_to_date",
                    "availableVersion": serde_json::Value::Null,
                    "notes": serde_json::Value::Null,
                    "progressPercent": serde_json::Value::Null,
                    "error": serde_json::Value::Null
                }),
            );
            if install {
                notify(&app, "Atelier sudah terbaru", "Tidak ada update.", false);
            }
        }
        Err(e) => {
            send_update_status(
                &app,
                json!({
                    "state": "error",
                    "progressPercent": serde_json::Value::Null,
                    "error": e.to_string()
                }),
            );
            if install {
                notify(&app, "Cek update gagal", "Periksa koneksi internet.", false);
            }
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Buka Atelier", true, None::<&str>)?,
            &MenuItem::with_id(app, "meeting", "Mulai / selesai catat meeting", true, None::<&str>)?,
            &MenuItem::with_id(app, "lock", "Kunci sekarang", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "data", "Buka folder data", true, None::<&str>)?,
            &MenuItem::with_id(app, "update", "Periksa update", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?,
        ],
    )?;
    let icon = Image::from_bytes(include_bytes!("../../assets/tray@2x.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Atelier")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "meeting" => app.state::<Sidecar>().send("meeting-toggle"),
            "lock" => app.state::<Sidecar>().send("lock"),
            "data" => {
                let mut cmd = Command::new("explorer.exe");
                cmd.arg(data_root());
                let _ = cmd.spawn();
            }
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(check_update(app, true));
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    // `Atelier.exe --reset-lock`: lost password + recovery key. Removes the app lock, then exits.
    if std::env::args().any(|a| a == "--reset-lock") {
        let out = server_command(Some("--reset-lock")).output();
        let msg = match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(e) => format!("Gagal reset lock: {e}"),
        };
        message_box(&msg);
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar::default())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(err) = start_server(&handle) {
                message_box(&err);
                handle.exit(1);
                return Ok(());
            }
            build_tray(&handle)?;
            meeting_detect::spawn(handle.state::<Sidecar>().detect.clone(), server_out(&handle));

            // Closing the window keeps agents running in the tray.
            if let Some(win) = app.get_webview_window("main") {
                let h = handle.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = h.state::<Sidecar>();
                        if state.quitting.load(Ordering::SeqCst) {
                            return;
                        }
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.hide();
                            tell_page(&w, true);
                        }
                        if !state.hint_shown.swap(true, Ordering::SeqCst) {
                            notify(
                                &h,
                                "Atelier tetap jalan di tray",
                                "Agent terus bekerja di background. Klik ikon tray untuk membuka lagi.",
                                false,
                            );
                        }
                    }
                });
            }

            // Look for updates shortly after start and every 30 minutes while running (never installs without user click).
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(15).await;
                loop {
                    if h.state::<Sidecar>().quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    check_update(h.clone(), false).await;
                    tokio_sleep(1800).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Atelier");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            // Window closed (no explicit exit code): stay alive in the tray.
            if code.is_none() && !app.state::<Sidecar>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}

async fn tokio_sleep(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(secs))).await;
}
