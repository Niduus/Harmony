# Account safety rules

The goal is for Harmony to behave like one careful person using an
ordinary client. Nothing here hides that it is a third-party client: the
protection comes from good behaviour, not disguise.

**No change to these rules, or to `safety.rs`, `discord/`, `auth/`, `core.rs`,
`updates/` or `ui/js/features.js`, goes in without the project owner's explicit approval.**

## Token

- Stored only in the OS keychain. Never written to a file, config or log.
- The `Token` type redacts itself in `Debug` and `Display`, and is zeroed in
  memory when dropped. The HTTP auth header is marked sensitive.
- The sign-in box is a password field and is wiped after use. The window (HTML/JS)
  hands the token to the Rust core once and never sees it again; every Discord
  call goes through the core.
- The window runs under a strict Content Security Policy: no inline scripts, and
  remote images only from Discord's CDN.
- "Sign in with Discord" shows discord.com's real login page in a private
  (incognito) window. Harmony never fills in, clicks or reads the form, and never
  sees the password. The window may only show discord.com, discordapp.com and
  hCaptcha pages; other links open in the browser and popups are refused. It has
  no access to Harmony's commands. A script reads only the session token Discord
  saves after you sign in, and hands it over through an address Harmony cancels,
  so it never leaves the PC. Harmony never solves or skips captchas.
- Every command that touches the account checks it came from Harmony's own
  window.
- A token Discord rejects (HTTP 401 or gateway close 4004) is never retried.

## No automation

- Every message sent comes from the user pressing Enter or clicking Send.
  There is no scripting, timer, auto-reply or plugin path that can send.
- The gateway only ever sends IDENTIFY, RESUME and heartbeats. No member
  list scraping (op 8/14), no presence tricks.
- History is fetched one page (50 messages) when you open a channel, once per
  session. Older pages load only when you scroll up, at most 8 per 30 seconds.
  No background crawling of channels you didn't open.
- DMs open only from your existing conversation list. Harmony never creates a
  new DM channel.
- Actions that aren't built with their own limits yet (reactions, replies,
  edits, deletes, pins, uploads, typing indicators, mention search) are switched
  off in `ui/js/features.js`, and the core refuses any request it doesn't know.

## Rate limits (stricter than Discord's)

| Limit | Value |
| --- | --- |
| Messages sent | 5 per 5 seconds, all channels combined |
| Message length | 2,000 characters (checked before sending) |
| Logins (IDENTIFY) | 6 per hour, then stop and tell the user |
| Reconnect attempts | exponential backoff with jitter, give up after 8 failures in a row |
| Rejected REST requests (401/403/429) | 25 in 10 minutes trips a breaker that stops all REST until restart |

- Discord's per-route rate-limit headers are read and obeyed before every request.
- `429` responses are honoured (`retry_after`, including global limits) and
  retried at most 3 times.
- A channel that returns 403 is marked "no access" and never requested again.
- Fatal gateway close codes (4010 to 4014) stop the client instead of looping.

## Updates

- Updates come only from this repo's GitHub Releases and never involve the
  Discord token.
- Each `Harmony-Setup.exe` must carry an Ed25519 signature over its tag and
  SHA-256, made with the key whose public half is built into Harmony. A missing
  or wrong signature means the download is deleted and not run.
- Local and source builds never update themselves.

## What this does not protect against

Discord can still detect a third-party client and act on the account. These
rules reduce risk; they cannot remove it. Use a test account.
