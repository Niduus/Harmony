//! Auto-updates from the Harmony repo's GitHub Releases.
//!
//! 1. Check: list releases, pick the newest `harmony-v*` one newer than this build.
//! 2. Download `Harmony-Setup.exe` and its `.sig`.
//! 3. Verify the Ed25519 signature against the key built into this exe (see signing.rs).
//!    Anything that fails is deleted and not run.
//! 4. Run the installer silently. It waits for Harmony to close, installs, and reopens it.
//!
//! The updater only talks to GitHub. Your Discord token is never involved.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::signing;

pub const REPO: &str = "Niduus/Harmony";
pub const TAG_PREFIX: &str = "harmony-v";
pub const SETUP_NAME: &str = "Harmony-Setup.exe";
pub const LOCAL_VERSION: &str = "local";
pub const SOURCE_VERSION: &str = "source";
const UPDATE_KEY: &str = include_str!("../update-key.pub");

/// The release tag this exe was built as. CI sets HARMONY_TAG; a hand build is "local",
/// a debug build "source".
pub fn installed_version() -> String {
    if cfg!(debug_assertions) {
        return SOURCE_VERSION.into();
    }
    option_env!("HARMONY_TAG").filter(|t| !t.is_empty()).unwrap_or(LOCAL_VERSION).into()
}

/// harmony-v0.2.14 -> [0, 2, 14]. Anything else -> None.
pub fn parse_version(tag: &str) -> Option<Vec<u64>> {
    tag.strip_prefix(TAG_PREFIX)?.split('.').map(|p| p.parse().ok()).collect()
}

pub fn display_version(tag: &str) -> String {
    match tag {
        LOCAL_VERSION => "local build".into(),
        SOURCE_VERSION => "source build".into(),
        _ => tag.strip_prefix(TAG_PREFIX).unwrap_or(tag).into(),
    }
}

pub fn is_newer(tag: &str, installed: &str) -> bool {
    match (parse_version(tag), parse_version(installed)) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(candidate), Some(current)) => candidate > current,
    }
}

pub fn key_configured() -> bool {
    signing::unhex(UPDATE_KEY).is_some_and(|k| k.len() == 32)
}

/// A GitHub sign-in for the release checks (the repo is private): HARMONY_GITHUB_TOKEN, or
/// the github.com sign-in git already stores on this PC, without ever showing a prompt.
fn github_token() -> String {
    if let Ok(value) = std::env::var("HARMONY_GITHUB_TOKEN") {
        if !value.trim().is_empty() {
            return value.trim().into();
        }
    }
    let mut command = Command::new("git");
    command.args(["credential", "fill"]).env("GCM_INTERACTIVE", "never").env("GIT_TERMINAL_PROMPT", "0");
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = command.spawn() else { return String::new() };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"protocol=https\nhost=github.com\n\n");
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return String::new(),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return String::new();
            }
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    out.lines().find_map(|l| l.strip_prefix("password=")).map(|v| v.trim().to_string()).unwrap_or_default()
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ReleaseInfo {
    pub checked_at: Option<i64>,
    pub ok: bool,
    pub error: String,
    pub installed: String,
    pub tag: String,
    pub name: String,
    pub notes: String,
    pub html_url: String,
    pub setup_url: String,
    pub setup_size: u64,
    pub sig_url: String,
    // Filled in by describe().
    pub available: bool,
    pub can_install: bool,
    pub blocked: String,
    pub version: String,
    pub installed_version: String,
}

impl ReleaseInfo {
    pub fn describe(mut self) -> Self {
        self.available = self.ok && !self.setup_url.is_empty() && is_newer(&self.tag, &self.installed);
        self.blocked = if !cfg!(windows) {
            "Installing updates works on Windows only.".into()
        } else if self.installed == SOURCE_VERSION {
            "Running from source: build it again to update.".into()
        } else if !key_configured() {
            "This build has no update-signing key, so it won't install updates.".into()
        } else if self.available && self.sig_url.is_empty() {
            "That release isn't signed, so Harmony won't install it.".into()
        } else {
            String::new()
        };
        self.can_install = self.available && self.blocked.is_empty();
        self.version = display_version(&self.tag);
        self.installed_version = display_version(&self.installed);
        self
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("Harmony-updater/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .build()
        .map_err(|e| e.to_string())
}

async fn token() -> String {
    tokio::task::spawn_blocking(github_token).await.unwrap_or_default()
}

pub async fn check(installed: &str) -> ReleaseInfo {
    let fail = |error: String| ReleaseInfo { checked_at: Some(now_ms()), error, installed: installed.into(), ..Default::default() }.describe();
    let token = token().await;
    let Ok(http) = client(Duration::from_secs(30)) else { return fail("Could not start the update check.".into()) };
    let mut request = http
        .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=20"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if !token.is_empty() {
        request = request.bearer_auth(&token);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return fail(format!("Could not reach GitHub: {}", e.without_url())),
    };
    let status = response.status().as_u16();
    if [401, 403, 404].contains(&status) {
        let hint = if token.is_empty() { " No GitHub sign-in was found: sign in with git once, or set HARMONY_GITHUB_TOKEN." } else { "" };
        return fail(format!("GitHub refused the update check (HTTP {status}).{hint}"));
    }
    if status != 200 {
        return fail(format!("GitHub answered HTTP {status}."));
    }
    let Ok(releases) = response.json::<Value>().await else { return fail("GitHub sent an unreadable release list.".into()) };
    let mut info = ReleaseInfo { checked_at: Some(now_ms()), ok: true, installed: installed.into(), ..Default::default() };
    let mut best: Option<(Vec<u64>, &Value)> = None;
    for release in releases.as_array().into_iter().flatten() {
        if release["draft"].as_bool().unwrap_or(false) || release["prerelease"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(version) = parse_version(release["tag_name"].as_str().unwrap_or_default()) else { continue };
        if best.as_ref().is_none_or(|(v, _)| &version > v) {
            best = Some((version, release));
        }
    }
    if let Some((_, release)) = best {
        let text = |key: &str| release[key].as_str().unwrap_or_default().to_string();
        info.tag = text("tag_name");
        info.name = if text("name").is_empty() { info.tag.clone() } else { text("name") };
        info.notes = text("body").trim().to_string();
        info.html_url = text("html_url");
        for asset in release["assets"].as_array().into_iter().flatten() {
            let url = asset["url"].as_str().unwrap_or_default().to_string();
            match asset["name"].as_str() {
                Some(SETUP_NAME) => {
                    info.setup_url = url;
                    info.setup_size = asset["size"].as_u64().unwrap_or(0);
                }
                Some(n) if n == format!("{SETUP_NAME}.sig") => info.sig_url = url,
                _ => {}
            }
        }
    }
    info.describe()
}

async fn download(http: &reqwest::Client, token: &str, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    // GitHub answers with a redirect to its file storage; reqwest drops the sign-in header
    // when a redirect leaves the host, so the token only ever goes to api.github.com.
    let mut request = http.get(url).header("Accept", "application/octet-stream");
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|e| format!("Download failed: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("Download failed (HTTP {}).", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| format!("Download failed: {}", e.without_url()))?;
    if bytes.len() as u64 > limit {
        return Err("The download is larger than expected.".into());
    }
    Ok(bytes.to_vec())
}

/// Download, verify and start the installer. On success the caller exits Harmony.
pub async fn install(info: &ReleaseInfo) -> Result<String, String> {
    if !info.can_install {
        return Err(if info.blocked.is_empty() { "No newer release to install.".into() } else { info.blocked.clone() });
    }
    let token = token().await;
    let http = client(Duration::from_secs(600))?;
    let setup = download(&http, &token, &info.setup_url, 300 * 1024 * 1024).await?;
    if info.setup_size > 0 && setup.len() as u64 != info.setup_size {
        return Err(format!("The download was cut short ({} of {} bytes).", setup.len(), info.setup_size));
    }
    let sig = download(&http, &token, &info.sig_url, 4096).await?;
    signing::verify(UPDATE_KEY, &info.tag, &setup, &String::from_utf8_lossy(&sig))?;

    let dir = std::env::temp_dir().join("harmony-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not save the update: {e}"))?;
    let path = dir.join(SETUP_NAME);
    std::fs::write(&path, &setup).map_err(|e| format!("Could not save the update: {e}"))?;
    spawn_setup(&path)?;
    Ok(format!("Installing {}. Harmony reopens by itself.", info.version))
}

fn spawn_setup(setup: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("The installer only runs on Windows.".into());
    }
    let log: PathBuf = setup.with_extension("log");
    let mut command = Command::new(setup);
    command
        .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH", &format!("/LOG={}", log.display())])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("Could not start the installer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("harmony-v0.2.14"), Some(vec![0, 2, 14]));
        assert_eq!(parse_version("panel-v1.0.0"), None);
        assert!(is_newer("harmony-v0.3.1", "harmony-v0.2.30"));
        assert!(!is_newer("harmony-v0.2.3", "harmony-v0.2.30"));
        assert!(is_newer("harmony-v0.2.1", "local"));
        assert!(!is_newer("junk", "local"));
        assert_eq!(display_version("harmony-v0.2.7"), "0.2.7");
    }

    #[test]
    fn unsigned_or_keyless_builds_never_install() {
        let info = ReleaseInfo { ok: true, tag: "harmony-v9.9.9".into(), installed: "harmony-v0.2.1".into(), setup_url: "x".into(), ..Default::default() }.describe();
        assert!(info.available);
        assert!(!info.can_install);
    }
}
