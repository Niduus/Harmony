//! "Sign in with Discord": Discord's real login page in a separate, private window.
//!
//! You type your email, password, captcha and 2FA code into discord.com itself, exactly as in
//! a browser. Harmony never sees the password. Once Discord has signed you in, a small script
//! reads the session token the page saved and hands it to Harmony, which closes the window.
//!
//! How it stays contained:
//! - The window is private (incognito): nothing it loads or stores is kept after it closes.
//! - It can only show Discord's own sign-in pages (and hCaptcha). Any other link opens in your
//!   browser instead, and popups are refused.
//! - It has no access to Harmony's commands: Tauri refuses calls from remote pages, and every
//!   account command also checks it was called from Harmony's main window.
//! - The token comes back as a navigation to a made-up address that Harmony cancels, so it never
//!   leaves the PC and isn't logged anywhere.
//! - Harmony doesn't touch the page otherwise: no clicks, no form filling, no automation.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::auth::token::Token;

const LABEL: &str = "discord-login";
const LOGIN_URL: &str = "https://discord.com/login";
/// The made-up address the script navigates to with the token. `.invalid` can never resolve.
const HANDOFF_HOST: &str = "harmony-sign-in.invalid";

/// Runs at the start of every discord.com page in the window, before Discord's own code (which
/// hides `localStorage` from later scripts). It only reads; it never changes the page.
const HANDOFF_SCRIPT: &str = r#"
(() => {
  if (location.hostname !== 'discord.com') return;
  let store;
  try { store = window.localStorage; } catch (e) { return; }
  if (!store) return;
  const timer = setInterval(() => {
    let raw = null;
    try { raw = store.getItem('token'); } catch (e) {}
    if (!raw) return;
    clearInterval(timer);
    try { raw = JSON.parse(raw); } catch (e) {}
    location.replace('https://harmony-sign-in.invalid/#' + encodeURIComponent(String(raw)));
  }, 400);
})();
"#;

/// Which addresses the window may show. Everything else opens in the browser.
fn allowed(url: &Url) -> bool {
    if url.scheme() == "about" || url.scheme() == "blob" || url.scheme() == "data" {
        return true;
    }
    let Some(host) = url.host_str() else { return false };
    url.scheme() == "https"
        && ["discord.com", "discordapp.com", "hcaptcha.com"]
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// The token in a handoff address, if this is one.
fn handoff_token(url: &Url) -> Option<Option<Token>> {
    if url.host_str() != Some(HANDOFF_HOST) {
        return None;
    }
    let raw = url.fragment().unwrap_or_default();
    let raw = percent_decode(raw);
    Some(Token::parse(&raw))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open the sign-in window (or bring it forward if it's already open). `done` runs once, with
/// the token, after Discord signs you in.
pub fn open<F>(handle: &AppHandle, done: F) -> Result<(), String>
where
    F: Fn(&AppHandle, Token) + Send + Sync + 'static,
{
    if let Some(window) = handle.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let url: Url = LOGIN_URL.parse().map_err(|_| "Bad sign-in address.".to_string())?;
    let nav_handle = handle.clone();
    let done = std::sync::Arc::new(done);
    let used = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    WebviewWindowBuilder::new(handle, LABEL, WebviewUrl::External(url))
        .title("Sign in to Discord")
        .inner_size(480.0, 720.0)
        .min_inner_size(400.0, 560.0)
        .center()
        .incognito(true)
        .initialization_script(HANDOFF_SCRIPT)
        .on_new_window(|url, _| {
            open_in_browser(&url);
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if let Some(token) = handoff_token(url) {
                if !used.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    let handle = nav_handle.clone();
                    let done = done.clone();
                    // Close and finish off this callback's thread: the webview is mid-navigation.
                    std::thread::spawn(move || {
                        if let Some(window) = handle.get_webview_window(LABEL) {
                            let _ = window.destroy();
                        }
                        match token {
                            Some(token) => done(&handle, token),
                            None => {
                                use tauri::Emitter;
                                let _ = handle.emit_to(
                                    "main",
                                    "signed-in",
                                    serde_json::json!({ "ok": false, "message": "Discord signed you in, but Harmony couldn't read the session. Try again, or paste your token." }),
                                );
                            }
                        }
                    });
                }
                return false;
            }
            if allowed(url) {
                return true;
            }
            open_in_browser(url);
            false
        })
        .build()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the sign-in window: {e}"))
}

fn open_in_browser(url: &Url) {
    if url.scheme() == "https" || url.scheme() == "http" {
        let _ = open::that_detached(url.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_discord_sign_in_pages_load_in_the_window() {
        for ok in ["https://discord.com/login", "https://discord.com/channels/@me", "https://newassets.hcaptcha.com/x", "https://cdn.discordapp.com/a.png"] {
            assert!(allowed(&ok.parse().unwrap()), "{ok}");
        }
        for bad in ["http://discord.com/login", "https://discord.com.evil.net/", "https://evildiscord.com/", "https://example.com/"] {
            assert!(!allowed(&bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn handoff_reads_the_token_only_from_the_handoff_address() {
        let token = format!("{}.{}.{}", "a".repeat(26), "b".repeat(6), "c".repeat(38));
        let url: Url = format!("https://{HANDOFF_HOST}/#{token}").parse().unwrap();
        assert_eq!(handoff_token(&url).unwrap().unwrap().expose(), token);
        let bad: Url = format!("https://{HANDOFF_HOST}/#short").parse().unwrap();
        assert!(handoff_token(&bad).unwrap().is_none());
        let other: Url = format!("https://discord.com/#{token}").parse().unwrap();
        assert!(handoff_token(&other).is_none());
    }

    #[test]
    fn script_hands_off_to_the_address_harmony_watches() {
        assert!(HANDOFF_SCRIPT.contains(&format!("https://{HANDOFF_HOST}/#")));
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("a%2Eb%"), "a.b%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
