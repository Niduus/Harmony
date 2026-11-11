//! The async side of the client. The UI sends `Command`s; the backend talks to
//! Discord and sends `Event`s back.
//!
//! Commands only ever come from the user's own input in the UI. There is no
//! scripting hook, timer or plugin path that can create them, which is how the
//! "no automation" rule is enforced structurally.

use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::mpsc;

use crate::model::{Channel, CurrentUser, Guild, Id, Message};
use crate::rest::{Rest, RestError};
use crate::safety::{self, Window};
use crate::token::Token;
use crate::gateway;

pub enum Command {
    Login(Token),
    Logout,
    OpenChannel(Id),
    Send { channel: Id, content: String },
}

pub enum Event {
    Status(String),
    Error(String),
    AuthFailed,
    LoggedOut,
    Ready { user: Option<CurrentUser>, guilds: Vec<Guild>, dms: Vec<Channel> },
    GuildUpsert(Guild),
    GuildDelete(Id),
    ChannelUpsert(Channel),
    ChannelDelete(Id),
    History { channel: Id, messages: Vec<Message> },
    NoAccess(Id),
    MessageUpsert(Message),
    MessageEdit { id: Id, channel_id: Id, content: String },
    MessageDelete { id: Id, channel_id: Id },
    SendFailed { channel: Id, content: String, error: String },
}

/// Sends events to the UI and wakes it up so they render immediately.
#[derive(Clone)]
pub struct Emitter {
    tx: std::sync::mpsc::Sender<Event>,
    ctx: eframe::egui::Context,
}

impl Emitter {
    pub fn send(&self, e: Event) {
        let _ = self.tx.send(e);
        self.ctx.request_repaint();
    }
}

/// Discord-style nonce so a double-submitted message is only posted once.
fn nonce() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (ms.saturating_sub(1_420_070_400_000) << 22).to_string()
}

pub fn spawn(rt: &tokio::runtime::Handle, ctx: eframe::egui::Context) -> (mpsc::UnboundedSender<Command>, std::sync::mpsc::Receiver<Event>) {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (ev_tx, ev_rx) = std::sync::mpsc::channel();
    let emit = Emitter { tx: ev_tx, ctx };
    rt.spawn(run(cmd_rx, emit));
    (cmd_tx, ev_rx)
}

struct Session {
    rest: Arc<Rest>,
    gateway: tokio::task::JoinHandle<()>,
}

async fn run(mut rx: mpsc::UnboundedReceiver<Command>, emit: Emitter) {
    let mut session: Option<Session> = None;
    let mut sends = Window::new(safety::SEND_MAX_IN_WINDOW, safety::SEND_WINDOW);
    // Channels we already loaded or were refused: never requested twice.
    let mut fetched: HashSet<Id> = HashSet::new();

    while let Some(cmd) = rx.recv().await {
        match cmd {
            Command::Login(token) => {
                if let Some(s) = session.take() {
                    s.gateway.abort();
                }
                fetched.clear();
                match Rest::new(&token) {
                    Ok(rest) => {
                        let gw = tokio::spawn(gateway::run(token, emit.clone()));
                        session = Some(Session { rest: Arc::new(rest), gateway: gw });
                    }
                    Err(e) => emit.send(Event::Error(format!("could not start: {e}"))),
                }
            }
            Command::Logout => {
                if let Some(s) = session.take() {
                    s.gateway.abort();
                }
                fetched.clear();
                if let Err(e) = crate::token::delete() {
                    emit.send(Event::Error(e));
                }
                emit.send(Event::LoggedOut);
            }
            Command::OpenChannel(id) => {
                let Some(s) = &session else { continue };
                if !fetched.insert(id) {
                    continue;
                }
                let rest = s.rest.clone();
                let emit = emit.clone();
                tokio::spawn(async move {
                    match rest.recent_messages(id).await {
                        Ok(messages) => emit.send(Event::History { channel: id, messages }),
                        Err(RestError::Forbidden) => emit.send(Event::NoAccess(id)),
                        Err(RestError::Unauthorized) => emit.send(Event::AuthFailed),
                        Err(e) => emit.send(Event::Error(format!("could not load messages: {e}"))),
                    }
                });
            }
            Command::Send { channel, content } => {
                let Some(s) = &session else { continue };
                let fail = |error: String| Event::SendFailed { channel, content: content.clone(), error };
                if content.trim().is_empty() {
                    continue;
                }
                if content.chars().count() > safety::MAX_MESSAGE_LEN {
                    emit.send(fail(format!("Message is over {} characters.", safety::MAX_MESSAGE_LEN)));
                    continue;
                }
                if !sends.try_hit() {
                    emit.send(fail("Slow down: sending is limited to protect your account.".into()));
                    continue;
                }
                let rest = s.rest.clone();
                let emit = emit.clone();
                tokio::spawn(async move {
                    match rest.send_message(channel, &content, &nonce()).await {
                        Ok(m) => emit.send(Event::MessageUpsert(m)),
                        Err(RestError::Unauthorized) => emit.send(Event::AuthFailed),
                        Err(e) => emit.send(Event::SendFailed { channel, content, error: e.to_string() }),
                    }
                });
            }
        }
    }
}
