# rdc

A small, fast, native Discord client written in Rust (egui + tokio).
Text chat only for now: servers, channels, DMs, reading and sending messages.

## Read this first

- **Using a third-party client is against Discord's Terms of Service.** Accounts
  can be banned for it. Use a **test account** you can afford to lose, not your
  main one.
- The client logs in with your **account token**. Anyone with that token has
  full control of your account. Never paste it anywhere else, never commit it,
  never share a screenshot of it.
- Account-safety rules are in [SAFETY.md](SAFETY.md). Changes to them need the
  project owner's explicit approval.

## Build and run

Needs Rust 1.88 or newer (`rustup update`).

```sh
cargo run --release
```

Linux needs a running Secret Service (GNOME Keyring or KWallet) for token
storage, plus the usual X11/Wayland libs (`libxkbcommon-x11`). macOS uses the
Keychain and Windows uses the Credential Manager. No extra setup there.

Logging goes to stderr. Set `RDC_LOG=debug` for more detail. The token and
message contents are never logged at any level.

## Getting a token

Log in to Discord in a browser with your test account, open DevTools, and copy
the `Authorization` header from any request to `discord.com/api`. Paste it into
rdc's login screen. It is saved to your OS keychain and nowhere else. "Log out"
deletes it from the keychain. Changing the account password invalidates it.

## Layout

| File | What it does |
| --- | --- |
| `src/main.rs` | Starts logging, the async runtime and the window |
| `src/app.rs` | The UI: login screen, server list, channel list, messages, composer |
| `src/backend.rs` | Turns UI commands into Discord calls, sends events back to the UI |
| `src/gateway.rs` | Websocket: login, heartbeat, resume, reconnect, events |
| `src/rest.rs` | HTTP API: rate limits, retries, circuit breaker |
| `src/safety.rs` | Every account-safety limit, in one place |
| `src/token.rs` | Token type that cannot be printed, keychain load/save/delete |
| `src/model.rs` | Guild, channel and message types, parsed defensively |

## Tests

```sh
cargo test
```
