//! Gateway (websocket) connection: login, heartbeat, resume and dispatch.
//!
//! Safety rules enforced here:
//! - A rejected token (close 4004) stops the client; it is never retried.
//! - Fatal close codes stop the client instead of reconnect-looping.
//! - Reconnects use exponential backoff with jitter and give up after
//!   `MAX_RECONNECT_ATTEMPTS` failures in a row.
//! - Sessions are resumed whenever possible; full logins (IDENTIFY) are capped
//!   per hour.
//! - The client never sends anything over the gateway except IDENTIFY, RESUME
//!   and heartbeats. No presence spoofing, no member scraping (op 8/14).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::safety::{self, Window};
use crate::token::Token;

const GATEWAY: &str = "wss://gateway.discord.gg";
const QUERY: &str = "/?v=10&encoding=json";

/// Where the gateway reports to. `core::Core` implements it.
pub trait Sink: Send + Sync {
    /// Connection state for the UI: "connecting", "online", "reconnecting" or "offline".
    fn status(&self, state: &str, text: &str);
    fn error(&self, text: String);
    fn auth_failed(&self);
    fn dispatch(&self, kind: &str, d: &Value);
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Session {
    id: String,
    resume_url: String,
    seq: Option<u64>,
}

enum Outcome {
    /// Connection ended; try again. `resume` says whether the session survives.
    Reconnect { resume: bool, was_ready: bool },
    /// Stop for good and tell the user why.
    Fatal(String),
    AuthFailed,
}

/// Cheap jitter without pulling in an RNG crate: 0.0..1.0
pub fn jitter() -> f64 {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (n % 1000) as f64 / 1000.0
}

pub async fn run(token: Token, emit: std::sync::Arc<dyn Sink>) {
    let mut session: Option<Session> = None;
    let mut identifies = Window::new(safety::IDENTIFY_MAX_PER_HOUR, Duration::from_secs(3600));
    let mut failures: u32 = 0;

    loop {
        let base = session.as_ref().map_or(GATEWAY, |s| s.resume_url.as_str());
        let url = format!("{}{QUERY}", base.trim_end_matches('/'));
        emit.status("connecting", if session.is_some() { "Resuming…" } else { "Connecting…" });

        let outcome = match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((ws, _)) => connection(ws, &token, &mut session, &mut identifies, emit.as_ref()).await,
            Err(e) => {
                tracing::warn!("gateway connect failed: {e}");
                Outcome::Reconnect { resume: true, was_ready: false }
            }
        };

        match outcome {
            Outcome::AuthFailed => {
                emit.auth_failed();
                return;
            }
            Outcome::Fatal(msg) => {
                emit.error(msg);
                emit.status("offline", "Disconnected");
                return;
            }
            Outcome::Reconnect { resume, was_ready } => {
                if !resume {
                    session = None;
                }
                failures = if was_ready { 0 } else { failures + 1 };
                if failures >= safety::MAX_RECONNECT_ATTEMPTS {
                    emit.error("Could not stay connected to Discord. Stopped retrying to protect the account; restart Harmony to try again.".into());
                    emit.status("offline", "Disconnected");
                    return;
                }
                let backoff = (2f64.powi(failures as i32)).min(60.0) * (0.5 + jitter());
                emit.status("reconnecting", &format!("Reconnecting in {backoff:.0}s…"));
                tokio::time::sleep(Duration::from_secs_f64(backoff.max(1.0))).await;
            }
        }
    }
}

async fn send_json(ws: &mut Ws, v: Value) -> Result<(), ()> {
    ws.send(WsMessage::text(v.to_string())).await.map_err(|_| ())
}

async fn connection(
    mut ws: Ws,
    token: &Token,
    session: &mut Option<Session>,
    identifies: &mut Window,
    emit: &dyn Sink,
) -> Outcome {
    let reconnect = |was_ready| Outcome::Reconnect { resume: true, was_ready };

    // 1. HELLO
    let interval_ms = loop {
        match tokio::time::timeout(Duration::from_secs(20), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(t)))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                if v["op"] == 10 {
                    break v["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250);
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => return reconnect(false),
        }
    };

    // 2. RESUME or IDENTIFY
    let sent = if let Some(s) = session.as_ref() {
        send_json(&mut ws, json!({"op": 6, "d": {
            "token": token.expose(), "session_id": s.id, "seq": s.seq
        }}))
        .await
    } else {
        if !identifies.try_hit() {
            return Outcome::Fatal(
                "Too many logins in the last hour. Stopped to protect the account; try again later.".into(),
            );
        }
        send_json(&mut ws, json!({"op": 2, "d": {
            "token": token.expose(),
            // Honest client properties: this does not impersonate the official client.
            "properties": {"os": std::env::consts::OS, "browser": "Harmony", "device": "Harmony"},
            "presence": {"status": "online", "since": 0, "activities": [], "afk": false},
            "compress": false
        }}))
        .await
    };
    if sent.is_err() {
        return reconnect(false);
    }

    // 3. Main loop
    let mut was_ready = false;
    let period = Duration::from_millis(interval_ms);
    let first = tokio::time::Instant::now() + period.mul_f64(jitter());
    let mut heartbeat = tokio::time::interval_at(first, period);
    let mut acked = true;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !acked {
                    tracing::warn!("heartbeat not acknowledged; reconnecting");
                    let _ = ws.close(None).await;
                    return reconnect(was_ready);
                }
                acked = false;
                let seq = session.as_ref().and_then(|s| s.seq);
                if send_json(&mut ws, json!({"op": 1, "d": seq})).await.is_err() {
                    return reconnect(was_ready);
                }
            }
            msg = ws.next() => {
                let text = match msg {
                    Some(Ok(WsMessage::Text(t))) => t,
                    Some(Ok(WsMessage::Close(frame))) => {
                        let code = frame.map(|f| u16::from(f.code)).unwrap_or(1000);
                        return close_outcome(code, was_ready);
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        tracing::warn!("gateway read error: {e}");
                        return reconnect(was_ready);
                    }
                    None => return reconnect(was_ready),
                };
                let v: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match v["op"].as_u64() {
                    Some(0) => {
                        if let (Some(s), Some(seq)) = (session.as_mut(), v["s"].as_u64()) {
                            s.seq = Some(seq);
                        }
                        let t = v["t"].as_str().unwrap_or_default();
                        if t == "READY" {
                            *session = Some(Session {
                                id: v["d"]["session_id"].as_str().unwrap_or_default().to_owned(),
                                resume_url: v["d"]["resume_gateway_url"].as_str().unwrap_or(GATEWAY).to_owned(),
                                seq: v["s"].as_u64(),
                            });
                            was_ready = true;
                        } else if t == "RESUMED" {
                            was_ready = true;
                        }
                        if t == "READY" || t == "RESUMED" {
                            emit.status("online", "Connected");
                        }
                        emit.dispatch(t, &v["d"]);
                    }
                    Some(1) => {
                        let seq = session.as_ref().and_then(|s| s.seq);
                        if send_json(&mut ws, json!({"op": 1, "d": seq})).await.is_err() {
                            return reconnect(was_ready);
                        }
                    }
                    Some(7) => {
                        let _ = ws.close(None).await;
                        return reconnect(true);
                    }
                    Some(9) => {
                        let resumable = v["d"].as_bool().unwrap_or(false);
                        if !resumable {
                            *session = None;
                        }
                        // Discord asks clients to wait 1-5s before re-identifying.
                        tokio::time::sleep(Duration::from_secs_f64(1.0 + 4.0 * jitter())).await;
                        let _ = ws.close(None).await;
                        return Outcome::Reconnect { resume: resumable, was_ready };
                    }
                    Some(11) => acked = true,
                    _ => {}
                }
            }
        }
    }
}

fn close_outcome(code: u16, was_ready: bool) -> Outcome {
    match code {
        4004 => Outcome::AuthFailed,
        4010..=4014 => Outcome::Fatal(format!("Discord closed the connection (code {code}). Not retrying.")),
        // Invalid sequence / session timed out: start a fresh session.
        4007 | 4009 => Outcome::Reconnect { resume: false, was_ready },
        // Rate limited by the gateway: treat as a failure so backoff grows.
        4008 => Outcome::Reconnect { resume: true, was_ready: false },
        c if c == u16::from(CloseCode::Normal) => Outcome::Reconnect { resume: false, was_ready },
        _ => Outcome::Reconnect { resume: true, was_ready },
    }
}
