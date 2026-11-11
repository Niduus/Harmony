# Account safety rules

The goal is for this client to behave like one careful person using an
ordinary client. Nothing here hides that it is a third-party client: the
protection comes from good behaviour, not disguise.

**No change to these rules, or to `safety.rs`, `rest.rs`, `gateway.rs` or
`token.rs`, goes in without the project owner's explicit approval.**

## Token

- Stored only in the OS keychain. Never written to a file, config or log.
- The `Token` type redacts itself in `Debug` and `Display`, and is zeroed in
  memory when dropped. The HTTP auth header is marked sensitive.
- The login text box is a password field and is wiped after use.
- A token Discord rejects (HTTP 401 or gateway close 4004) is never retried.

## No automation

- Every message sent comes from the user pressing Enter or clicking Send.
  There is no scripting, timer, auto-reply or plugin path that can send.
- The gateway only ever sends IDENTIFY, RESUME and heartbeats. No member
  list scraping (op 8/14), no presence tricks.
- History is fetched one page (50 messages) when you open a channel, once.
  No bulk pagination, no background crawling of channels you didn't open.

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

## What this does not protect against

Discord can still detect a third-party client and act on the account. These
rules reduce risk; they cannot remove it. Use a test account.
