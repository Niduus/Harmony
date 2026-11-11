//! The heart of Harmony: the signed-in session, the store, and the small API the window
//! calls. The window never talks to Discord itself. It asks here, and every request goes
//! through the safety limits in `safety.rs` and the rate limiter in `rest.rs`.
//!
//! The API answers the same routes (and shapes) hbv's panel used, so its chat code works
//! as-is. Routes that act on other people's messages (react, edit, delete, pin, typing,
//! uploads) answer "not yet": they arrive one phase at a time, each with its own limits.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::describe;
use crate::gateway::{self, Sink};
use crate::rest::{Rest, RestError};
use crate::safety::{self, Window};
use crate::store::{sf, snowflake_ms, History, Id, Store};
use crate::token::Token;

pub struct Core {
    handle: AppHandle,
    store: Mutex<Store>,
    rest: Mutex<Option<Arc<Rest>>>,
    gateway: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    sends: Mutex<Window>,
    older_pages: Mutex<Window>,
    status: Mutex<Value>,
}

type ApiResult = Result<Value, String>;

fn arg_id(v: &Value, key: &str) -> Result<Id, String> {
    sf(v, key).ok_or_else(|| format!("Missing or invalid {key}."))
}

fn rest_error(e: RestError, what: &str) -> String {
    match e {
        RestError::Forbidden => format!("You don't have access to {what}."),
        other => other.to_string(),
    }
}

impl Core {
    pub fn new(handle: AppHandle) -> Arc<Self> {
        Arc::new(Core {
            handle,
            store: Mutex::new(Store::default()),
            rest: Mutex::new(None),
            gateway: Mutex::new(None),
            sends: Mutex::new(Window::new(safety::SEND_MAX_IN_WINDOW, safety::SEND_WINDOW)),
            older_pages: Mutex::new(Window::new(safety::OLDER_PAGES_IN_WINDOW, safety::OLDER_PAGES_WINDOW)),
            status: Mutex::new(json!({ "state": "offline", "text": "Signed out" })),
        })
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.handle.emit(event, payload);
    }

    fn event(&self, payload: Value) {
        self.emit("bot-event", payload);
    }

    pub fn status(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    pub fn signed_in(&self) -> bool {
        self.rest.lock().unwrap().is_some()
    }

    // ---------------------------------------------------------------- session

    pub fn start(self: &Arc<Self>, token: Token) -> Result<(), String> {
        self.stop();
        let rest = Rest::new(&token).map_err(|e| format!("Could not start: {e}"))?;
        *self.rest.lock().unwrap() = Some(Arc::new(rest));
        let sink: Arc<dyn Sink> = self.clone();
        let task = tauri::async_runtime::spawn(gateway::run(token, sink));
        *self.gateway.lock().unwrap() = Some(task);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(task) = self.gateway.lock().unwrap().take() {
            task.abort();
        }
        *self.rest.lock().unwrap() = None;
        *self.store.lock().unwrap() = Store::default();
        Sink::status(self, "offline", "Signed out");
    }

    fn rest(&self) -> Result<Arc<Rest>, String> {
        self.rest.lock().unwrap().clone().ok_or_else(|| "You're signed out.".to_string())
    }

    // ---------------------------------------------------------------- the window's API

    pub async fn api(&self, method: &str, route: &str, query: &Value, body: &Value) -> Value {
        let result = match (method, route) {
            ("GET", "/api/overview") => Ok(self.store.lock().unwrap().overview()),
            ("GET", "/api/guild") => self.guild(query),
            ("GET", "/api/channel/messages") => self.channel_messages(query).await,
            ("GET", "/api/dms") => Ok(self.store.lock().unwrap().dm_list()),
            ("GET", "/api/dm") => self.dm(query).await,
            ("POST", "/api/say") => self.say(body).await,
            ("POST", "/api/dm/send") => self.dm_send(body).await,
            ("GET", "/api/emojis") => Ok(json!({ "emojis": [] })),
            ("GET", "/api/mentions") => Ok(json!({ "mentions": [] })),
            _ => Err("That isn't in Harmony yet.".to_string()),
        };
        match result {
            Ok(data) => json!({ "ok": true, "data": data, "error": "" }),
            Err(error) => json!({ "ok": false, "data": {}, "error": error }),
        }
    }

    fn guild(&self, query: &Value) -> ApiResult {
        let id = arg_id(query, "id")?;
        self.store.lock().unwrap().guild_detail(id).ok_or_else(|| "You're not in that server.".to_string())
    }

    /// The newest page of a channel: from memory if Harmony already has it, otherwise one
    /// request, once per session. Older pages only when you scroll up, and rate-capped.
    async fn history(&self, channel: Id, before: Option<Id>, what: &str) -> Result<(Vec<Value>, bool), String> {
        if self.store.lock().unwrap().no_access.contains(&channel) {
            return Err(format!("You don't have access to {what}."));
        }
        if before.is_none() {
            let store = self.store.lock().unwrap();
            if let Some(h) = store.histories.get(&channel) {
                return Ok((h.messages.iter().filter_map(|m| describe::message(m, &store)).collect(), h.more));
            }
        } else if !self.older_pages.lock().unwrap().try_hit() {
            return Err("Slow down: older messages load at a limited pace to protect your account.".into());
        }
        let rest = self.rest()?;
        let mut raw = match rest.messages(channel, before).await {
            Ok(raw) => raw,
            Err(RestError::Forbidden) => {
                self.store.lock().unwrap().no_access.insert(channel);
                return Err(format!("You don't have access to {what}."));
            }
            Err(RestError::Unauthorized) => {
                self.auth_failed();
                return Err("Discord rejected your token.".into());
            }
            Err(e) => return Err(rest_error(e, what)),
        };
        raw.reverse();
        let more = raw.len() as u32 >= safety::HISTORY_PAGE;
        let mut store = self.store.lock().unwrap();
        let described = raw.iter().filter_map(|m| describe::message(m, &store)).collect();
        if before.is_none() {
            let mut h = History { messages: raw.into_iter().collect::<VecDeque<_>>(), more };
            while h.messages.len() > safety::MAX_CACHED_PER_CHANNEL {
                h.messages.pop_front();
            }
            store.histories.insert(channel, h);
        }
        Ok((described, more))
    }

    async fn channel_messages(&self, query: &Value) -> ApiResult {
        let channel = arg_id(query, "channelId")?;
        let (name, text) = {
            let store = self.store.lock().unwrap();
            let c = store.channel(channel).ok_or("That channel no longer exists.")?;
            (c.name.clone(), c.is_text())
        };
        if !text {
            return Err("Harmony shows text channels for now.".into());
        }
        let (messages, more) = self.history(channel, sf(query, "before"), &format!("#{name}")).await?;
        Ok(json!({ "channel": { "id": channel.to_string(), "name": name }, "messages": messages, "more": more }))
    }

    async fn dm(&self, query: &Value) -> ApiResult {
        let user_id = arg_id(query, "userId")?;
        let (channel, user) = {
            let store = self.store.lock().unwrap();
            // Only DMs you already have. Opening new DMs with strangers is a classic spam
            // signal, so Harmony doesn't do it.
            let channel = *store.dm_by_user.get(&user_id).ok_or("Harmony opens DMs from your conversation list only.")?;
            (channel, store.user(user_id))
        };
        let (messages, more) = self.history(channel, sf(query, "before"), "this conversation").await?;
        {
            let mut store = self.store.lock().unwrap();
            if let Some(dm) = store.dms.get_mut(&channel) {
                dm.unread = 0;
            }
        }
        Ok(json!({
            "user": { "id": user_id.to_string(), "name": user.name(), "username": user.username, "avatar": user.avatar_url() },
            "channelId": channel.to_string(),
            "messages": messages,
            "more": more,
        }))
    }

    /// Every message Harmony sends goes through here: length check, then the send limit.
    async fn send(&self, channel: Id, body: &Value) -> ApiResult {
        let text = body["text"].as_str().unwrap_or_default().trim().to_owned();
        if text.is_empty() {
            return Err("Type a message first.".into());
        }
        if text.chars().count() > safety::MAX_MESSAGE_LEN {
            return Err(format!("Messages can be at most {} characters.", safety::MAX_MESSAGE_LEN));
        }
        if self.store.lock().unwrap().no_access.contains(&channel) {
            return Err("You don't have access to this channel.".into());
        }
        if !self.sends.lock().unwrap().try_hit() {
            return Err("Slow down: sending is limited to protect your account.".into());
        }
        let nonce: String = body["nonce"].as_str().unwrap_or_default().chars().filter(char::is_ascii_alphanumeric).take(25).collect();
        let raw = match self.rest()?.send_message(channel, &text, &nonce).await {
            Ok(raw) => raw,
            Err(RestError::Unauthorized) => {
                self.auth_failed();
                return Err("Discord rejected your token.".into());
            }
            Err(e) => return Err(rest_error(e, "this channel")),
        };
        let store = self.store.lock().unwrap();
        Ok(json!({ "message": "Sent.", "sent": describe::message(&raw, &store) }))
    }

    async fn say(&self, body: &Value) -> ApiResult {
        let channel = arg_id(body, "channelId")?;
        if !self.store.lock().unwrap().channel(channel).is_some_and(|c| c.is_text()) {
            return Err("Pick a text channel.".into());
        }
        self.send(channel, body).await
    }

    async fn dm_send(&self, body: &Value) -> ApiResult {
        let user_id = arg_id(body, "userId")?;
        let channel = *self.store.lock().unwrap().dm_by_user.get(&user_id).ok_or("Harmony sends DMs in your existing conversations only.")?;
        self.send(channel, body).await
    }

    // ---------------------------------------------------------------- live events

    fn chat_target(&self, store: &Store, channel_id: Id, guild_id: Option<Id>) -> Option<Value> {
        if let Some(gid) = guild_id.or_else(|| store.channel(channel_id).and_then(|c| c.guild_id)) {
            return Some(json!({ "guildId": gid.to_string(), "channelId": channel_id.to_string() }));
        }
        let dm = store.dms.get(&channel_id)?;
        Some(json!({ "guildId": "", "channelId": channel_id.to_string(), "userId": dm.user_id.to_string() }))
    }

    fn on_message(&self, op: &str, d: &Value) {
        let Some(channel_id) = sf(d, "channel_id") else { return };
        let mut store = self.store.lock().unwrap();
        if let Some(author) = d.get("author") {
            store.remember_user(author);
        }
        let Some(mut event) = self.chat_target(&store, channel_id, sf(d, "guild_id")) else { return };
        event["type"] = json!("message");
        event["op"] = json!(op);
        let id = sf(d, "id");

        if op == "delete" {
            if let Some(h) = store.histories.get_mut(&channel_id) {
                h.messages.retain(|m| sf(m, "id") != id);
            }
            event["id"] = json!(id.map(|i| i.to_string()).unwrap_or_default());
            drop(store);
            return self.event(event);
        }

        // Keep the remembered history current, so reopening the chat needs no request.
        let full = if op == "update" {
            let Some(h) = store.histories.get_mut(&channel_id) else { return };
            let Some(old) = h.messages.iter_mut().find(|m| sf(m, "id") == id) else { return };
            if let (Some(o), Some(n)) = (old.as_object_mut(), d.as_object()) {
                for (k, v) in n {
                    o.insert(k.clone(), v.clone());
                }
            }
            old.clone()
        } else {
            if let Some(h) = store.histories.get_mut(&channel_id) {
                if !h.messages.iter().any(|m| sf(m, "id") == id) {
                    h.messages.push_back(d.clone());
                    if h.messages.len() > safety::MAX_CACHED_PER_CHANNEL {
                        h.messages.pop_front();
                    }
                }
            }
            d.clone()
        };

        let mine = sf(&full["author"], "id") == Some(store.me_id());
        let mut dms_changed = false;
        if op == "create" {
            if let Some(dm) = store.dms.get_mut(&channel_id) {
                dm.last_at = id.map(snowflake_ms).unwrap_or(dm.last_at);
                dm.last_preview = describe::preview(&full);
                if !mine {
                    dm.unread += 1;
                }
                dms_changed = true;
            }
        }
        event["message"] = describe::message(&full, &store).unwrap_or(Value::Null);
        drop(store);
        self.event(event);
        if dms_changed {
            self.event(json!({ "type": "dms" }));
        }
    }

    fn on_typing(&self, d: &Value) {
        let store = self.store.lock().unwrap();
        let (Some(channel_id), Some(user_id)) = (sf(d, "channel_id"), sf(d, "user_id")) else { return };
        if user_id == store.me_id() {
            return;
        }
        let Some(mut event) = self.chat_target(&store, channel_id, sf(d, "guild_id")) else { return };
        let nick = d.pointer("/member/nick").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_owned);
        let name = nick
            .or_else(|| d.pointer("/member/user").and_then(crate::store::User::parse).map(|u| u.name()))
            .unwrap_or_else(|| store.user(user_id).name());
        event["type"] = json!("typing");
        event["authorId"] = json!(user_id.to_string());
        event["name"] = json!(name);
        drop(store);
        self.event(event);
    }
}

impl Sink for Core {
    fn status(&self, state: &str, text: &str) {
        let value = json!({ "state": state, "text": text });
        *self.status.lock().unwrap() = value.clone();
        self.emit("status", value);
    }

    fn error(&self, text: String) {
        self.emit("app-error", json!({ "text": text }));
    }

    fn auth_failed(&self) {
        if let Some(task) = self.gateway.lock().unwrap().take() {
            task.abort();
        }
        *self.rest.lock().unwrap() = None;
        Sink::status(self, "offline", "Token rejected");
        self.emit("auth-failed", json!({}));
    }

    fn dispatch(&self, kind: &str, d: &Value) {
        match kind {
            "READY" => {
                self.store.lock().unwrap().load_ready(d);
                self.event(json!({ "type": "resync" }));
            }
            "RESUMED" => self.event(json!({ "type": "resync" })),
            "GUILD_CREATE" | "GUILD_UPDATE" => {
                let mut store = self.store.lock().unwrap();
                if kind == "GUILD_UPDATE" {
                    // Updates carry no channels: keep the ones Harmony has.
                    if let Some(id) = sf(d, "id") {
                        if let (Some(old), Some(new)) = (store.guilds.get(&id).cloned(), crate::store::Guild::parse(d)) {
                            store.guilds.insert(id, crate::store::Guild { channels: old.channels, ..new });
                        }
                    }
                } else {
                    store.add_guild(d);
                }
                drop(store);
                self.event(json!({ "type": "overview" }));
            }
            "GUILD_DELETE" => {
                if let Some(id) = sf(d, "id") {
                    self.store.lock().unwrap().remove_guild(id);
                    self.event(json!({ "type": "overview" }));
                }
            }
            "CHANNEL_CREATE" | "CHANNEL_UPDATE" => {
                let mut store = self.store.lock().unwrap();
                let guild = store.upsert_channel(d);
                let dm = if guild.is_none() { store.add_private_channel(d) } else { None };
                drop(store);
                if let Some(gid) = guild {
                    self.event(json!({ "type": "guild", "guildId": gid.to_string() }));
                } else if dm.is_some() {
                    self.event(json!({ "type": "dms" }));
                }
            }
            "CHANNEL_DELETE" => {
                let guild = self.store.lock().unwrap().delete_channel(d);
                match guild {
                    Some(gid) => self.event(json!({ "type": "guild", "guildId": gid.to_string() })),
                    None => self.event(json!({ "type": "dms" })),
                }
            }
            "MESSAGE_CREATE" => self.on_message("create", d),
            "MESSAGE_UPDATE" => self.on_message("update", d),
            "MESSAGE_DELETE" => self.on_message("delete", d),
            "TYPING_START" => self.on_typing(d),
            _ => {}
        }
    }
}
