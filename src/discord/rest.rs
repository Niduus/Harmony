//! REST client with rate-limit handling and a circuit breaker.
//!
//! Every request goes through `Rest::request`, which:
//! - waits for the route's rate-limit bucket and any global limit before sending,
//! - honours `429 Retry-After` and retries at most a couple of times,
//! - counts 401/403/429 responses, and stops all REST traffic if they pile up.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::state::Id;
use crate::safety::{self, Window};
use crate::auth::token::Token;

const API: &str = "https://discord.com/api/v10";
const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug)]
pub enum RestError {
    /// Token rejected. The UI should send the user back to the login screen.
    Unauthorized,
    /// No access to this resource (e.g. a channel you cannot read).
    Forbidden,
    /// Still rate limited after retries.
    RateLimited,
    /// The circuit breaker tripped; REST is disabled until restart.
    Tripped,
    Status(u16),
    Http(String),
}

impl std::fmt::Display for RestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => f.write_str("token was rejected (401)"),
            Self::Forbidden => f.write_str("no access (403)"),
            Self::RateLimited => f.write_str("rate limited, try again shortly"),
            Self::Tripped => f.write_str(
                "too many rejected requests; networking paused to protect the account. Restart the client.",
            ),
            Self::Status(s) => write!(f, "HTTP {s}"),
            Self::Http(e) => write!(f, "network error: {e}"),
        }
    }
}

#[derive(Default)]
struct Bucket {
    remaining: Option<u32>,
    reset_at: Option<Instant>,
}

struct State {
    buckets: HashMap<String, Bucket>,
    global_until: Option<Instant>,
    invalid: Window,
    tripped: bool,
}

pub struct Rest {
    http: reqwest::Client,
    state: Mutex<State>,
}

impl Rest {
    pub fn new(token: &Token) -> anyhow::Result<Self> {
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(token.expose())?;
        // Marks the header so reqwest/hyper never print it in debug output.
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);
        // Honest identification. This client does not pretend to be the official one.
        headers.insert(USER_AGENT, HeaderValue::from_static(concat!("Harmony/", env!("CARGO_PKG_VERSION"))));
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(20))
            .https_only(true)
            .build()?;
        Ok(Self {
            http,
            state: Mutex::new(State {
                buckets: HashMap::new(),
                global_until: None,
                invalid: Window::new(safety::INVALID_LIMIT, safety::INVALID_WINDOW),
                tripped: false,
            }),
        })
    }

    /// Waits until the bucket (and global limit) allow a request, then reserves a slot.
    async fn wait_turn(&self, key: &str) -> Result<(), RestError> {
        loop {
            let wait = {
                let mut st = self.state.lock().await;
                if st.tripped {
                    return Err(RestError::Tripped);
                }
                let now = Instant::now();
                let global = st.global_until.filter(|t| *t > now).map(|t| t - now);
                let b = st.buckets.entry(key.to_owned()).or_default();
                let bucket_wait = match (b.remaining, b.reset_at) {
                    (Some(0), Some(r)) if r > now => Some(r - now),
                    (Some(0), _) => {
                        b.remaining = None;
                        None
                    }
                    _ => None,
                };
                match global.max(bucket_wait) {
                    Some(w) => Some(w),
                    None => {
                        if let Some(r) = b.remaining.as_mut() {
                            *r = r.saturating_sub(1);
                        }
                        None
                    }
                }
            };
            match wait {
                Some(w) => tokio::time::sleep(w + Duration::from_millis(50)).await,
                None => return Ok(()),
            }
        }
    }

    async fn note_invalid(&self) -> bool {
        let mut st = self.state.lock().await;
        if st.invalid.hit_and_check_exceeded() {
            st.tripped = true;
            tracing::error!("REST circuit breaker tripped; all REST requests disabled");
        }
        st.tripped
    }

    async fn update_bucket(&self, key: &str, h: &HeaderMap) {
        let num = |name: &str| h.get(name).and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<f64>().ok());
        let mut st = self.state.lock().await;
        let b = st.buckets.entry(key.to_owned()).or_default();
        if let Some(r) = num("x-ratelimit-remaining") {
            b.remaining = Some(r as u32);
        }
        if let Some(after) = num("x-ratelimit-reset-after") {
            b.reset_at = Some(Instant::now() + Duration::from_secs_f64(after));
        }
    }

    async fn request(&self, method: Method, path: &str, key: &str, body: Option<Value>) -> Result<Value, RestError> {
        for _ in 0..MAX_ATTEMPTS {
            self.wait_turn(key).await?;
            let mut req = self.http.request(method.clone(), format!("{API}{path}"));
            if let Some(b) = &body {
                req = req.json(b);
            }
            let resp = req.send().await.map_err(|e| RestError::Http(e.without_url().to_string()))?;
            let status = resp.status();
            self.update_bucket(key, resp.headers()).await;
            tracing::debug!(%method, key, status = status.as_u16(), "rest");

            match status {
                StatusCode::TOO_MANY_REQUESTS => {
                    let v: Value = resp.json().await.unwrap_or(Value::Null);
                    let retry = v.get("retry_after").and_then(Value::as_f64).unwrap_or(5.0).clamp(0.5, 120.0);
                    if v.get("global").and_then(Value::as_bool).unwrap_or(false) {
                        self.state.lock().await.global_until = Some(Instant::now() + Duration::from_secs_f64(retry));
                    }
                    if self.note_invalid().await {
                        return Err(RestError::Tripped);
                    }
                    tracing::warn!(key, retry, "rate limited by Discord, backing off");
                    tokio::time::sleep(Duration::from_secs_f64(retry)).await;
                }
                StatusCode::UNAUTHORIZED => {
                    self.note_invalid().await;
                    // A rejected token must never be retried.
                    self.state.lock().await.tripped = true;
                    return Err(RestError::Unauthorized);
                }
                StatusCode::FORBIDDEN => {
                    self.note_invalid().await;
                    return Err(RestError::Forbidden);
                }
                StatusCode::NO_CONTENT => return Ok(Value::Null),
                s if s.is_success() => {
                    return resp.json().await.map_err(|e| RestError::Http(e.without_url().to_string()));
                }
                s => return Err(RestError::Status(s.as_u16())),
            }
        }
        Err(RestError::RateLimited)
    }

    /// One page of history (newest first, as Discord sends it), optionally before a message.
    pub async fn messages(&self, channel: Id, before: Option<Id>) -> Result<Vec<Value>, RestError> {
        let mut path = format!("/channels/{channel}/messages?limit={}", safety::HISTORY_PAGE);
        if let Some(b) = before {
            path.push_str(&format!("&before={b}"));
        }
        let key = format!("GET /channels/{channel}/messages");
        let v = self.request(Method::GET, &path, &key, None).await?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    pub async fn send_message(&self, channel: Id, content: &str, nonce: &str) -> Result<Value, RestError> {
        let path = format!("/channels/{channel}/messages");
        let key = format!("POST /channels/{channel}/messages");
        let body = json!({ "content": content, "nonce": nonce, "enforce_nonce": true });
        self.request(Method::POST, &path, &key, Some(body)).await
    }
}
