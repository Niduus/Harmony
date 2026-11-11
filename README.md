# Harmony

A fast, native Discord client for Windows, written in Rust. The window is a Tauri app drawn by
the system WebView, laid out like Discord, with its own name and look.

Phase 1 is text chat: your servers, channels and DMs, reading and sending messages, plus signed
auto-updates. Reactions, replies, edits, uploads and the rest arrive in later phases, each with
its own safety limits. Voice comes last.

![Chat](docs/chat.png)

## Read this first

- **Third-party clients are against Discord's Terms of Service.** Accounts can be banned for
  using one. Use a **test account** you can afford to lose, not your main one.
- Harmony signs in with your **account token**. Anyone with that token has full control of your
  account. Never paste it anywhere else, never commit it, never share a screenshot of it.
- The account-safety rules are in [SAFETY.md](SAFETY.md). Changes to them need the project
  owner's explicit approval.

## Install

Download `Harmony-Setup.exe` from the newest release (a `harmony-v…` release, or a `harmony-test-…` test build until signing is set up) and run it. It installs for
your Windows user only (no admin) into `%LOCALAPPDATA%\Programs\Harmony`, and adds the Microsoft
WebView2 runtime if your PC doesn't have it.

Harmony checks its GitHub Releases at start and every 30 minutes (Settings > Updates). An update
installs only if its signature matches the key built into Harmony; anything else is deleted
unrun. The repo is private, so the updater needs a GitHub token: set `HARMONY_GITHUB_TOKEN`, or
sign in to GitHub with Git for Windows (Harmony asks `git credential fill`).

## Signing in

**Sign in with Discord** opens Discord's own sign-in page in a separate private window. You type
your email, password, captcha and 2FA code there, exactly as in a browser; Harmony never sees
your password. Once Discord signs you in, Harmony takes the session token, closes the window
(which keeps nothing), and stores the token in the Windows Credential Manager.

Or paste a token: sign in to Discord in a browser with your test account, open DevTools (F12) >
Network, filter for `api`, click any request and copy its `authorization` request header.

Sign out (Settings > Account) deletes the token. Changing the account's password invalidates it.

## Build from source

Needs Rust from https://rustup.rs.

```powershell
powershell -ExecutionPolicy Bypass -File build-exe.ps1
```

That runs the tests and writes `build\Harmony.exe`. A hand build is a "local build" and never
updates itself. `cargo run` starts a debug build. Logs go to stderr; set `HARMONY_LOG=debug` for
more. The token and message text are never logged.

## Releases and the update key (one-time setup)

Every push to `main` builds and publishes Harmony (`.github/workflows/release.yml`).

Until the update-signing key exists, each build is an **unsigned test build**: a pre-release
named `harmony-test-<n>` with `Harmony-Setup.exe` and `harmony-keygen.exe`. It installs and runs
normally but never updates itself, and Harmony never installs a test build as an update.

To turn on signed releases and auto-updates, once:

1. Download `harmony-keygen.exe` from the newest test build and double-click it (or run
   `cargo run --release --bin harmony-keygen`).
2. Add the **private** key it shows as the Actions secret **HARMONY_SIGNING_KEY**
   ([New secret](https://github.com/Niduus/Harmony/settings/secrets/actions/new)). Paste it
   nowhere else: anyone with it can sign updates.
3. Commit the **public** key it shows as `update-key.pub` (or send it to Claude to commit).

From then on every build is a signed `harmony-v<version>` release that installed copies update to.

## Layout

Each part of Harmony has one job, and only `core.rs` connects them.

| Path | What it does |
| --- | --- |
| `ui/` | The window: HTML, CSS and ES modules (layout adapted from the hbv launcher UI). It never sees the token |
| `ui/js/features.js` | Which actions the UI offers; everything not built yet is off |
| `src/main.rs` | Window, the commands the UI can call, single instance |
| `src/core.rs` | Answers the UI's requests from Discord, through the safety limits |
| `src/state.rs` | Application state: servers, channels, DMs and history Harmony knows about |
| `src/safety.rs` | Every account-safety limit, in one place |
| `src/auth/` | `token.rs` (token type that can't be printed; keychain) and `login_window.rs` (Sign in with Discord) |
| `src/discord/` | `gateway.rs` (websocket), `rest.rs` (HTTP API, rate limits, breaker), `describe.rs` (messages for the UI) |
| `src/perf/` | Potato / Balanced / Enthusiast profiles, and `memory.rs`, the memory meter |
| `src/settings.rs` | Settings saved on this PC (never the token) |
| `src/updates/` | Update check, download, signature check (`signing.rs`), install |
| `src/bin/` | `harmony-keygen` and `harmony-sign`, the release-signing tools |
| `installer.iss`, `build-exe.ps1` | The Windows installer and build |
| `deny.toml` | Dependency rules checked in CI: no known advisories, no abandoned or yanked crates |

## Tests

```sh
cargo test
cargo deny check advisories bans sources   # needs: cargo install cargo-deny
```
