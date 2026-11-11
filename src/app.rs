//! The egui user interface. Immediate-mode and redrawn only when something
//! changes (input or a backend event), so it stays light when idle.

use std::collections::{HashMap, HashSet};

use eframe::egui::{self, Color32, Key, Modifiers, RichText};
use tokio::sync::mpsc::UnboundedSender;

use crate::backend::{self, Command, Event};
use crate::model::{Channel, ChannelKind, CurrentUser, Guild, Id, Message};
use crate::safety;
use crate::token::{self, Token};

#[derive(PartialEq)]
enum Screen {
    Login,
    Main,
}

pub struct App {
    cmd: UnboundedSender<Command>,
    events: std::sync::mpsc::Receiver<Event>,
    screen: Screen,
    token_input: String,
    login_error: Option<String>,

    user: Option<CurrentUser>,
    guilds: Vec<Guild>,
    dms: Vec<Channel>,
    /// `None` means the Direct Messages list is selected.
    selected_guild: Option<Id>,
    selected_channel: Option<Id>,
    messages: HashMap<Id, Vec<Message>>,
    no_access: HashSet<Id>,
    drafts: HashMap<Id, String>,
    status: String,
    error: Option<String>,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, rt: &tokio::runtime::Handle) -> Self {
        let (cmd, events) = backend::spawn(rt, cc.egui_ctx.clone());
        let mut app = Self {
            cmd,
            events,
            screen: Screen::Login,
            token_input: String::new(),
            login_error: None,
            user: None,
            guilds: Vec::new(),
            dms: Vec::new(),
            selected_guild: None,
            selected_channel: None,
            messages: HashMap::new(),
            no_access: HashSet::new(),
            drafts: HashMap::new(),
            status: String::new(),
            error: None,
        };
        match token::load() {
            Ok(Some(t)) => app.login(t),
            Ok(None) => {}
            Err(e) => app.login_error = Some(e),
        }
        app
    }

    fn login(&mut self, t: Token) {
        let _ = self.cmd.send(Command::Login(t));
        self.screen = Screen::Main;
        self.status = "Connecting…".into();
    }

    fn reset_session(&mut self) {
        self.user = None;
        self.guilds.clear();
        self.dms.clear();
        self.selected_guild = None;
        self.selected_channel = None;
        self.messages.clear();
        self.no_access.clear();
        self.drafts.clear();
        self.error = None;
        self.screen = Screen::Login;
    }

    fn handle(&mut self, ev: Event) {
        match ev {
            Event::Status(s) => self.status = s,
            Event::Error(e) => self.error = Some(e),
            Event::AuthFailed => {
                self.reset_session();
                self.login_error = Some(
                    "Discord rejected the saved token (it may have been reset by a password change). Log out to clear it, then paste a new one.".into(),
                );
            }
            Event::LoggedOut => self.reset_session(),
            Event::Ready { user, guilds, dms } => {
                self.user = user;
                self.guilds = guilds;
                self.dms = dms;
                self.dms.sort_by_key(|c| std::cmp::Reverse(c.id));
            }
            Event::GuildUpsert(g) => match self.guilds.iter_mut().find(|x| x.id == g.id) {
                Some(x) => *x = g,
                None => self.guilds.push(g),
            },
            Event::GuildDelete(id) => self.guilds.retain(|g| g.id != id),
            Event::ChannelUpsert(c) => {
                let (list, is_guild) = match c.guild_id {
                    Some(gid) => match self.guilds.iter_mut().find(|g| g.id == gid) {
                        Some(g) => (&mut g.channels, true),
                        None => return,
                    },
                    None => (&mut self.dms, false),
                };
                match list.iter_mut().find(|x| x.id == c.id) {
                    Some(x) => *x = c,
                    None => list.push(c),
                }
                if is_guild {
                    crate::model::sort_channels(list);
                }
            }
            Event::ChannelDelete(id) => {
                self.dms.retain(|c| c.id != id);
                for g in &mut self.guilds {
                    g.channels.retain(|c| c.id != id);
                }
                if self.selected_channel == Some(id) {
                    self.selected_channel = None;
                }
            }
            Event::History { channel, messages } => {
                let list = self.messages.entry(channel).or_default();
                for m in messages {
                    upsert(list, m);
                }
            }
            Event::NoAccess(id) => {
                self.no_access.insert(id);
            }
            Event::MessageUpsert(m) => {
                // Only keep live messages for channels already loaded; others
                // load fresh when opened.
                if let Some(list) = self.messages.get_mut(&m.channel_id) {
                    upsert(list, m);
                }
            }
            Event::MessageEdit { id, channel_id, content } => {
                if let Some(m) = self.messages.get_mut(&channel_id).and_then(|l| l.iter_mut().find(|m| m.id == id)) {
                    m.content = content;
                    m.edited = true;
                }
            }
            Event::MessageDelete { id, channel_id } => {
                if let Some(l) = self.messages.get_mut(&channel_id) {
                    l.retain(|m| m.id != id);
                }
            }
            Event::SendFailed { channel, content, error } => {
                // Give the text back so nothing typed is lost.
                let d = self.drafts.entry(channel).or_default();
                if d.is_empty() {
                    *d = content;
                }
                self.error = Some(format!("Not sent: {error}"));
            }
        }
    }

    fn login_screen(&mut self, ui: &mut egui::Ui) {
        egui::CentralPanel::default_margins().show(ui, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(60.0);
                ui.heading("rdc");
                ui.add_space(12.0);
                ui.label(
                    RichText::new(
                        "Third-party clients are against Discord's Terms of Service and can get an account banned.\nUse a test account you can afford to lose.",
                    )
                    .color(Color32::from_rgb(230, 170, 60)),
                );
                ui.add_space(16.0);
                ui.label("Paste your account token. It is stored only in your OS keychain.");
                let resp = ui.add(
                    egui::TextEdit::singleline(&mut self.token_input)
                        .password(true)
                        .hint_text("token")
                        .desired_width(420.0),
                );
                let submit = ui.button("Log in").clicked() || (resp.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)));
                if submit {
                    match Token::parse(&self.token_input) {
                        Some(t) => {
                            if let Err(e) = token::save(&t) {
                                self.error = Some(format!("{e}. The token will be used for this session only."));
                            }
                            wipe(&mut self.token_input);
                            self.login_error = None;
                            self.login(t);
                        }
                        None => self.login_error = Some("That does not look like an account token.".into()),
                    }
                }
                if let Some(e) = &self.login_error {
                    ui.add_space(8.0);
                    ui.colored_label(Color32::from_rgb(230, 90, 90), e);
                    if ui.button("Log out and forget saved token").clicked() {
                        let _ = self.cmd.send(Command::Logout);
                        self.login_error = None;
                    }
                }
            });
        });
    }

    fn main_screen(&mut self, ui: &mut egui::Ui) {
        egui::Panel::top("top").show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new(self.user.as_ref().map_or("…", |u| u.name.as_str())).strong());
                ui.separator();
                ui.label(&self.status);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Log out").clicked() {
                        let _ = self.cmd.send(Command::Logout);
                    }
                });
            });
            if let Some(e) = self.error.clone() {
                ui.horizontal(|ui| {
                    ui.colored_label(Color32::from_rgb(230, 90, 90), e);
                    if ui.small_button("✕").clicked() {
                        self.error = None;
                    }
                });
            }
        });

        egui::Panel::left("guilds").resizable(false).exact_size(180.0).show(ui, |ui| {
            egui::ScrollArea::vertical().auto_shrink([false; 2]).show(ui, |ui| {
                if ui.selectable_label(self.selected_guild.is_none(), "Direct Messages").clicked() {
                    self.selected_guild = None;
                }
                ui.separator();
                for g in &self.guilds {
                    if ui.selectable_label(self.selected_guild == Some(g.id), &g.name).clicked() {
                        self.selected_guild = Some(g.id);
                    }
                }
            });
        });

        let mut open: Option<Id> = None;
        egui::Panel::left("channels").default_size(220.0).show(ui, |ui| {
            egui::ScrollArea::vertical().auto_shrink([false; 2]).show(ui, |ui| {
                let list: &[Channel] = match self.selected_guild {
                    None => &self.dms,
                    Some(gid) => self.guilds.iter().find(|g| g.id == gid).map_or(&[], |g| &g.channels),
                };
                for c in list {
                    match c.kind {
                        ChannelKind::Category => {
                            ui.add_space(6.0);
                            ui.label(RichText::new(c.name.to_uppercase()).small().weak());
                        }
                        k if k.is_text() => {
                            let prefix = if c.guild_id.is_some() { "# " } else { "" };
                            let mut text = RichText::new(format!("{prefix}{}", c.name));
                            if self.no_access.contains(&c.id) {
                                text = text.weak();
                            }
                            if ui.selectable_label(self.selected_channel == Some(c.id), text).clicked() {
                                open = Some(c.id);
                            }
                        }
                        _ => {
                            ui.label(RichText::new(format!("🔊 {}", c.name)).weak());
                        }
                    }
                }
            });
        });
        if let Some(id) = open {
            self.selected_channel = Some(id);
            if !self.messages.contains_key(&id) && !self.no_access.contains(&id) {
                let _ = self.cmd.send(Command::OpenChannel(id));
            }
        }

        let Some(ch) = self.selected_channel else {
            egui::CentralPanel::default_margins().show(ui, |ui| {
                ui.centered_and_justified(|ui| ui.label(RichText::new("Pick a channel").weak()));
            });
            return;
        };

        if !self.no_access.contains(&ch) {
            egui::Panel::bottom("composer").show(ui, |ui| self.composer(ui, ch));
        }

        egui::CentralPanel::default_margins().show(ui, |ui| {
            if self.no_access.contains(&ch) {
                ui.label(RichText::new("You don't have access to this channel.").weak());
                return;
            }
            let Some(msgs) = self.messages.get(&ch) else {
                ui.spinner();
                return;
            };
            egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink([false; 2]).show(ui, |ui| {
                let mut prev_author: Option<&str> = None;
                for m in msgs {
                    if prev_author != Some(m.author.as_str()) {
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(&m.author).strong());
                            ui.label(RichText::new(short_time(&m.timestamp)).small().weak());
                        });
                    }
                    prev_author = Some(m.author.as_str());
                    let mut body = m.content.clone();
                    if m.attachments > 0 {
                        body.push_str(&format!(" [{} attachment(s)]", m.attachments));
                    }
                    if m.edited {
                        body.push_str(" (edited)");
                    }
                    if !body.is_empty() {
                        ui.add(egui::Label::new(body).wrap());
                    }
                }
            });
        });
    }

    fn composer(&mut self, ui: &mut egui::Ui, ch: Id) {
        let id = egui::Id::unique("composer");
        // Enter sends, Shift+Enter makes a new line. Every send is a keypress
        // or click by the user; nothing else can trigger one.
        let enter = ui.memory(|m| m.has_focus(id)) && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter));
        let draft = self.drafts.entry(ch).or_default();
        let len = draft.chars().count();
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::multiline(draft)
                    .id(id)
                    .desired_rows(1)
                    .desired_width(ui.available_width() - 70.0)
                    .hint_text("Message"),
            );
            let clicked = ui.button("Send").clicked();
            if (enter || clicked) && !draft.trim().is_empty() && len <= safety::MAX_MESSAGE_LEN {
                let content = std::mem::take(draft);
                let _ = self.cmd.send(Command::Send { channel: ch, content });
            }
        });
        if len > safety::MAX_MESSAGE_LEN {
            ui.colored_label(Color32::from_rgb(230, 90, 90), format!("{len}/{}", safety::MAX_MESSAGE_LEN));
        }
        ui.add_space(4.0);
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        while let Ok(ev) = self.events.try_recv() {
            self.handle(ev);
        }
        match self.screen {
            Screen::Login => self.login_screen(ui),
            Screen::Main => self.main_screen(ui),
        }
    }
}

fn upsert(list: &mut Vec<Message>, m: Message) {
    match list.binary_search_by_key(&m.id, |x| x.id) {
        Ok(i) => list[i] = m,
        Err(i) => list.insert(i, m),
    }
    if list.len() > safety::MAX_CACHED_PER_CHANNEL {
        let excess = list.len() - safety::MAX_CACHED_PER_CHANNEL;
        list.drain(..excess);
    }
}

/// "2026-11-11T07:04:52.123+00:00" -> "2026-11-11 07:04" (UTC).
fn short_time(ts: &str) -> String {
    match (ts.get(..10), ts.get(11..16)) {
        (Some(d), Some(t)) => format!("{d} {t}"),
        _ => String::new(),
    }
}

fn wipe(s: &mut String) {
    // SAFETY: zero bytes keep the string valid UTF-8.
    unsafe {
        for b in s.as_bytes_mut() {
            std::ptr::write_volatile(b, 0);
        }
    }
    s.clear();
}
