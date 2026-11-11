//! Harmony: a fast native Discord client.
//!
//! The window (ui/) is plain HTML, CSS and JavaScript drawn by the system WebView. It never
//! sees your token and never talks to Discord directly: it calls the commands below, and
//! `core.rs` does the work through the safety limits in `safety.rs`.
//!
//! Read SAFETY.md before changing safety.rs, rest.rs, gateway.rs, token.rs or core.rs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod describe;
mod gateway;
mod login_window;
mod rest;
mod safety;
mod signing;
mod store;
mod token;
mod updates;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

use crate::core::Core;
use crate::token::Token;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    auto_check_updates: bool,
    auto_install_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto_check_updates: true, auto_install_updates: false }
    }
}

struct App {
    core: Arc<Core>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    installed: String,
    release: Mutex<updates::ReleaseInfo>,
    release_busy: AtomicBool,
    shown: AtomicBool,
    updated: bool,
    keychain_error: Mutex<String>,
}

type Shared<'a> = State<'a, Arc<App>>;

#[tauri::command]
fn init(app: Shared<'_>) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "installed": app.installed,
        "displayVersion": updates::display_version(&app.installed),
        "signedIn": app.core.signed_in(),
        "status": app.core.status(),
        "settings": *app.settings.lock().unwrap(),
        "release": *app.release.lock().unwrap(),
        "platform": std::env::consts::OS,
        "flags": { "updated": app.updated },
        "keychainError": *app.keychain_error.lock().unwrap(),
    })
}

#[tauri::command]
fn window_ready(app: Shared<'_>, handle: AppHandle) {
    show_window(&handle, &app);
}

fn show_window(handle: &AppHandle, app: &App) {
    if app.shown.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Only Harmony's own window may call the commands that touch the account. Tauri already
/// refuses commands from remote pages (like the Discord sign-in window); this is a second lock.
fn from_main(webview: &Webview) -> Result<(), Value> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err(json!({ "ok": false, "message": "Not allowed from this window." }))
    }
}

/// Sign in with a pasted token: check its shape, keep it in the OS keychain, connect.
#[tauri::command]
fn login(app: Shared<'_>, webview: Webview, token: String) -> Value {
    if let Err(denied) = from_main(&webview) {
        return denied;
    }
    let Some(token) = Token::parse(&token) else {
        return json!({ "ok": false, "message": "That doesn't look like an account token." });
    };
    sign_in(&app, token)
}

/// Keep the token in the keychain and connect. Used by both ways of signing in.
fn sign_in(app: &App, token: Token) -> Value {
    let mut note = String::new();
    if let Err(e) = token::save(&token) {
        note = format!(" ({e}. Harmony will use the token for this session only.)");
    }
    match app.core.start(token) {
        Ok(()) => json!({ "ok": true, "message": format!("Signing in…{note}") }),
        Err(e) => json!({ "ok": false, "message": e }),
    }
}

/// Sign in on Discord's own login page, in a separate private window. See login_window.rs.
#[tauri::command]
fn login_discord(app: Shared<'_>, webview: Webview, handle: AppHandle) -> Value {
    if let Err(denied) = from_main(&webview) {
        return denied;
    }
    let app = app.inner().clone();
    let opened = login_window::open(&handle, move |handle, token| {
        let result = sign_in(&app, token);
        let _ = handle.emit_to("main", "signed-in", &result);
    });
    match opened {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "message": e }),
    }
}

/// Sign out: disconnect and delete the token from the keychain.
#[tauri::command]
fn logout(app: Shared<'_>, webview: Webview) -> Value {
    if let Err(denied) = from_main(&webview) {
        return denied;
    }
    app.core.stop();
    match token::delete() {
        Ok(()) => json!({ "ok": true, "message": "Signed out. Your token was removed from this PC." }),
        Err(e) => json!({ "ok": false, "message": e }),
    }
}

#[tauri::command]
async fn api(app: Shared<'_>, webview: Webview, method: String, route: String, query: Option<Value>, body: Option<Value>) -> Result<Value, String> {
    if let Err(denied) = from_main(&webview) {
        return Ok(denied);
    }
    let core = app.core.clone();
    Ok(core.api(&method, &route, &query.unwrap_or(Value::Null), &body.unwrap_or(Value::Null)).await)
}

#[tauri::command]
fn open_url(url: String) -> Value {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return json!({ "ok": false });
    }
    json!({ "ok": open::that_detached(&url).is_ok() })
}

#[tauri::command]
fn settings_set(app: Shared<'_>, settings: Value) -> Value {
    let parsed: Settings = serde_json::from_value(settings).unwrap_or_default();
    if let Some(dir) = app.settings_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&app.settings_path, serde_json::to_string_pretty(&parsed).unwrap_or_default());
    *app.settings.lock().unwrap() = parsed.clone();
    json!(parsed)
}

#[tauri::command]
async fn release_check(app: Shared<'_>, handle: AppHandle) -> Result<Value, String> {
    let info = updates::check(&app.installed).await;
    *app.release.lock().unwrap() = info.clone();
    let _ = handle.emit("release", &info);
    Ok(json!(info))
}

#[tauri::command]
async fn release_install(app: Shared<'_>, handle: AppHandle) -> Result<Value, String> {
    if app.release_busy.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "ok": false, "message": "An update is already being installed." }));
    }
    let info = app.release.lock().unwrap().clone();
    let result = updates::install(&info).await;
    app.release_busy.store(false, Ordering::SeqCst);
    match result {
        Ok(message) => {
            let exit = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(600));
                exit.exit(0);
            });
            Ok(json!({ "ok": true, "message": message }))
        }
        Err(message) => Ok(json!({ "ok": false, "message": message })),
    }
}

// --------------------------------------------------------------------------- single instance

/// Only one Harmony runs at a time. The installer waits on this same mutex name before it
/// replaces Harmony's files.
#[cfg(windows)]
fn claim_single_instance() -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = "Local\\HarmonyClient".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            return true;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE};
            let title: Vec<u16> = "Harmony".encode_utf16().chain(std::iter::once(0)).collect();
            let window = FindWindowW(std::ptr::null(), title.as_ptr());
            if !window.is_null() {
                ShowWindow(window, SW_RESTORE);
                SetForegroundWindow(window);
            }
            return false;
        }
        true
    }
}

#[cfg(not(windows))]
fn claim_single_instance() -> bool {
    true
}

fn main() {
    // Logs go to stderr only. Nothing in Harmony logs the token or message text.
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("HARMONY_LOG").unwrap_or_else(|_| "warn,harmony=info".into()))
        .with_writer(std::io::stderr)
        .init();
    if !claim_single_instance() {
        return;
    }
    let updated = std::env::args().any(|a| a == "--updated");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![init, window_ready, login, login_discord, logout, api, open_url, settings_set, release_check, release_install])
        .setup(move |tauri_app| {
            let handle = tauri_app.handle().clone();
            let settings_path = handle.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("settings.json");
            let settings: Settings = std::fs::read_to_string(&settings_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            let installed = updates::installed_version();
            let app = Arc::new(App {
                core: Core::new(handle.clone()),
                settings: Mutex::new(settings),
                settings_path,
                release: Mutex::new(updates::ReleaseInfo { installed: installed.clone(), ..Default::default() }.describe()),
                installed,
                release_busy: AtomicBool::new(false),
                shown: AtomicBool::new(false),
                updated,
                keychain_error: Mutex::new(String::new()),
            });
            match token::load() {
                Ok(Some(token)) => {
                    if let Err(e) = app.core.start(token) {
                        *app.keychain_error.lock().unwrap() = e;
                    }
                }
                Ok(None) => {}
                Err(e) => *app.keychain_error.lock().unwrap() = e,
            }
            tauri_app.manage(app.clone());
            // Show the window even if the page never says it's ready.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                show_window(&handle, &app);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Harmony");
}
