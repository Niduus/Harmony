//! What Harmony knows about the account right now, built from the gateway's READY and
//! kept current by its events. Everything the UI shows comes from here or from a REST
//! call the user's own click caused.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{json, Value};

pub type Id = u64;

pub fn snowflake(v: &Value) -> Option<Id> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64())
}

pub fn sf(v: &Value, key: &str) -> Option<Id> {
    v.get(key).and_then(snowflake)
}

pub fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// Milliseconds since 1970 from a snowflake id.
pub fn snowflake_ms(id: Id) -> i64 {
    ((id >> 22) + 1_420_070_400_000) as i64
}

const CDN: &str = "https://cdn.discordapp.com";

#[derive(Debug, Clone, Default)]
pub struct User {
    pub id: Id,
    pub username: String,
    pub global_name: String,
    pub avatar: String,
    pub bot: bool,
}

impl User {
    pub fn parse(v: &Value) -> Option<Self> {
        Some(User {
            id: sf(v, "id")?,
            username: text(v, "username"),
            global_name: text(v, "global_name"),
            avatar: text(v, "avatar"),
            bot: v.get("bot").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    pub fn name(&self) -> String {
        if !self.global_name.is_empty() {
            self.global_name.clone()
        } else if !self.username.is_empty() {
            self.username.clone()
        } else {
            format!("User {}", self.id)
        }
    }

    pub fn avatar_url(&self) -> String {
        if self.avatar.is_empty() {
            format!("{CDN}/embed/avatars/{}.png", (self.id >> 22) % 6)
        } else {
            format!("{CDN}/avatars/{}/{}.png?size=64", self.id, self.avatar)
        }
    }
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: Id,
    pub guild_id: Option<Id>,
    pub parent_id: Option<Id>,
    pub name: String,
    pub kind: u64,
    pub position: i64,
}

impl Channel {
    pub fn parse(v: &Value, guild_id: Option<Id>) -> Option<Self> {
        Some(Channel {
            id: sf(v, "id")?,
            guild_id: guild_id.or_else(|| sf(v, "guild_id")),
            parent_id: sf(v, "parent_id"),
            name: text(v, "name"),
            kind: v.get("type")?.as_u64()?,
            position: v.get("position").and_then(Value::as_i64).unwrap_or(0),
        })
    }

    /// The kind names the UI uses.
    pub fn ui_kind(&self) -> &'static str {
        match self.kind {
            0 | 5 => "text",
            2 | 13 => "voice",
            4 => "category",
            15 | 16 => "forum",
            10..=12 => "post",
            _ => "other",
        }
    }

    pub fn is_text(&self) -> bool {
        matches!(self.kind, 0 | 1 | 3 | 5)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Role {
    pub name: String,
    pub color: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Guild {
    pub id: Id,
    pub name: String,
    pub icon: String,
    pub roles: HashMap<Id, Role>,
    pub channels: HashMap<Id, Channel>,
}

impl Guild {
    pub fn parse(v: &Value) -> Option<Self> {
        let id = sf(v, "id")?;
        let props = v.get("properties").unwrap_or(&Value::Null);
        let pick = |key: &str| {
            let direct = text(v, key);
            if direct.is_empty() { text(props, key) } else { direct }
        };
        let mut guild = Guild { id, name: pick("name"), icon: pick("icon"), ..Default::default() };
        for c in v.get("channels").and_then(Value::as_array).into_iter().flatten() {
            if let Some(c) = Channel::parse(c, Some(id)) {
                guild.channels.insert(c.id, c);
            }
        }
        for r in v.get("roles").and_then(Value::as_array).into_iter().flatten() {
            if let Some(rid) = sf(r, "id") {
                guild.roles.insert(rid, Role { name: text(r, "name"), color: r.get("color").and_then(Value::as_u64).unwrap_or(0) });
            }
        }
        Some(guild)
    }

    pub fn icon_url(&self) -> String {
        if self.icon.is_empty() {
            String::new()
        } else {
            format!("{CDN}/icons/{}/{}.png?size=128", self.id, self.icon)
        }
    }
}

/// A one-to-one DM. Group DMs come in a later phase.
#[derive(Debug, Clone, Default)]
pub struct Dm {
    pub user_id: Id,
    pub last_at: i64,
    pub last_preview: String,
    pub unread: u32,
}

/// Recent messages Harmony already has for a channel, so reopening it costs no request.
#[derive(Debug, Default)]
pub struct History {
    pub messages: VecDeque<Value>,
    pub more: bool,
}

#[derive(Debug, Default)]
pub struct Store {
    pub me: Option<User>,
    pub guild_order: Vec<Id>,
    pub guilds: HashMap<Id, Guild>,
    pub users: HashMap<Id, User>,
    pub dms: HashMap<Id, Dm>,
    pub dm_by_user: HashMap<Id, Id>,
    pub histories: HashMap<Id, History>,
    pub no_access: HashSet<Id>,
}

impl Store {
    pub fn me_id(&self) -> Id {
        self.me.as_ref().map_or(0, |u| u.id)
    }

    pub fn remember_user(&mut self, v: &Value) {
        if let Some(u) = User::parse(v) {
            self.users.insert(u.id, u);
        }
    }

    pub fn user(&self, id: Id) -> User {
        self.users.get(&id).cloned().unwrap_or(User { id, ..Default::default() })
    }

    pub fn load_ready(&mut self, d: &Value) {
        *self = Store::default();
        self.me = User::parse(&d["user"]);
        for u in d["users"].as_array().into_iter().flatten() {
            self.remember_user(u);
        }
        for g in d["guilds"].as_array().into_iter().flatten() {
            self.add_guild(g);
        }
        for c in d["private_channels"].as_array().into_iter().flatten() {
            self.add_private_channel(c);
        }
    }

    pub fn add_guild(&mut self, v: &Value) -> Option<Id> {
        if v.get("unavailable").and_then(Value::as_bool).unwrap_or(false) {
            return None;
        }
        let g = Guild::parse(v)?;
        let id = g.id;
        if !self.guild_order.contains(&id) {
            self.guild_order.push(id);
        }
        self.guilds.insert(id, g);
        Some(id)
    }

    pub fn remove_guild(&mut self, id: Id) {
        self.guilds.remove(&id);
        self.guild_order.retain(|g| *g != id);
    }

    /// Returns the DM's user id when the channel is a one-to-one DM.
    pub fn add_private_channel(&mut self, v: &Value) -> Option<Id> {
        if v.get("type").and_then(Value::as_u64) != Some(1) {
            return None;
        }
        let channel_id = sf(v, "id")?;
        // Older payloads list recipients in full; newer ones give ids and put users in READY.users.
        let mut user_id = None;
        if let Some(r) = v.get("recipients").and_then(Value::as_array).and_then(|a| a.first()) {
            self.remember_user(r);
            user_id = sf(r, "id");
        }
        if user_id.is_none() {
            user_id = v.get("recipient_ids").and_then(Value::as_array).and_then(|a| a.first()).and_then(snowflake);
        }
        let user_id = user_id?;
        let last_at = sf(v, "last_message_id").map(snowflake_ms).unwrap_or(0);
        let entry = self.dms.entry(channel_id).or_insert_with(|| Dm { user_id, ..Default::default() });
        entry.user_id = user_id;
        entry.last_at = entry.last_at.max(last_at);
        self.dm_by_user.insert(user_id, channel_id);
        Some(user_id)
    }

    pub fn channel(&self, id: Id) -> Option<&Channel> {
        self.guilds.values().find_map(|g| g.channels.get(&id))
    }

    pub fn channel_name(&self, id: Id) -> Option<String> {
        self.channel(id).map(|c| c.name.clone())
    }

    pub fn upsert_channel(&mut self, v: &Value) -> Option<Id> {
        let c = Channel::parse(v, None)?;
        let gid = c.guild_id?;
        self.guilds.get_mut(&gid)?.channels.insert(c.id, c);
        Some(gid)
    }

    pub fn delete_channel(&mut self, v: &Value) -> Option<Id> {
        let id = sf(v, "id")?;
        self.histories.remove(&id);
        if let Some(dm) = self.dms.remove(&id) {
            self.dm_by_user.remove(&dm.user_id);
            return None;
        }
        let gid = sf(v, "guild_id")?;
        self.guilds.get_mut(&gid)?.channels.remove(&id);
        Some(gid)
    }

    // ---------------------------------------------------------------- what the UI asks for

    pub fn overview(&self) -> Value {
        let me = self.me.clone().unwrap_or_default();
        let guilds: Vec<Value> = self
            .guild_order
            .iter()
            .filter_map(|id| self.guilds.get(id))
            .map(|g| json!({ "id": g.id.to_string(), "name": g.name, "icon": g.icon_url(), "home": false, "shroud": false, "members": 0 }))
            .collect();
        json!({
            "bot": { "id": me.id.to_string(), "name": me.name(), "tag": me.username, "avatar": me.avatar_url(), "mood": "" },
            "guilds": guilds,
        })
    }

    pub fn guild_detail(&self, id: Id) -> Option<Value> {
        let g = self.guilds.get(&id)?;
        let mut rows: Vec<(i64, i64, bool, i64, Id, Value)> = Vec::new();
        for c in g.channels.values() {
            let kind = c.ui_kind();
            if matches!(kind, "category" | "other" | "post") {
                continue;
            }
            let cat = c.parent_id.and_then(|p| g.channels.get(&p));
            let cat_pos = cat.map_or(-1, |p| p.position);
            let row = json!({
                "id": c.id.to_string(),
                "name": c.name,
                "kind": kind,
                "category": cat.map(|p| p.name.clone()).unwrap_or_default(),
                "categoryPosition": cat_pos,
                "locked": false,
                "hidden": false,
                "muted": self.no_access.contains(&c.id),
                "voiceMembers": 0,
                "voice": [],
                "links": [],
                "sticky": null,
            });
            rows.push((cat_pos, cat.map_or(0, |p| p.id as i64), kind == "voice", c.position, c.id, row));
        }
        rows.sort_by(|a, b| (a.0, a.1, a.2, a.3, a.4).cmp(&(b.0, b.1, b.2, b.3, b.4)));
        Some(json!({
            "guild": { "id": g.id.to_string(), "name": g.name, "home": false },
            "channels": rows.into_iter().map(|r| r.5).collect::<Vec<_>>(),
        }))
    }

    pub fn dm_list(&self) -> Value {
        let mut list: Vec<&Dm> = self.dms.values().collect();
        list.sort_by_key(|d| std::cmp::Reverse(d.last_at));
        let conversations: Vec<Value> = list
            .iter()
            .map(|d| {
                let u = self.user(d.user_id);
                json!({
                    "userId": d.user_id.to_string(),
                    "name": u.name(),
                    "username": u.username,
                    "avatar": u.avatar_url(),
                    "lastAt": d.last_at,
                    "lastPreview": d.last_preview,
                    "unread": d.unread,
                })
            })
            .collect();
        let unread: u32 = self.dms.values().map(|d| d.unread).sum();
        json!({ "conversations": conversations, "unread": unread, "scan": null })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_builds_guilds_and_dms() {
        let mut s = Store::default();
        s.load_ready(&json!({
            "user": {"id": "1", "username": "me"},
            "users": [{"id": "9", "username": "friend", "global_name": "Friend"}],
            "guilds": [{
                "id": "2", "properties": {"name": "Test"},
                "channels": [
                    {"id": "3", "type": 4, "name": "Text", "position": 0},
                    {"id": "4", "type": 0, "name": "general", "parent_id": "3", "position": 1},
                    {"id": "5", "type": 2, "name": "Voice", "parent_id": "3", "position": 0}
                ]
            }],
            "private_channels": [{"id": "7", "type": 1, "recipient_ids": ["9"], "last_message_id": "1000000000000000000"}]
        }));
        let detail = s.guild_detail(2).unwrap();
        let names: Vec<_> = detail["channels"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, vec!["general", "Voice"]);
        assert_eq!(s.overview()["guilds"][0]["name"], "Test");
        assert_eq!(s.dm_list()["conversations"][0]["name"], "Friend");
        assert_eq!(s.dm_by_user.get(&9), Some(&7));
    }

    #[test]
    fn default_avatar() {
        let u = User { id: 1 << 22, ..Default::default() };
        assert!(u.avatar_url().ends_with("/embed/avatars/1.png"));
    }
}
