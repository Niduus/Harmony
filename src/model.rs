//! Plain data types shared by the backend and the UI. Parsed defensively from
//! raw JSON so unknown or missing fields never crash the client.

use serde_json::Value;

pub type Id = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Text,
    Announcement,
    Category,
    Voice,
    Dm,
    GroupDm,
    Other,
}

impl ChannelKind {
    fn from_type(t: u64) -> Self {
        match t {
            0 => Self::Text,
            1 => Self::Dm,
            2 | 13 => Self::Voice,
            3 => Self::GroupDm,
            4 => Self::Category,
            5 => Self::Announcement,
            _ => Self::Other,
        }
    }

    /// Whether this client can show and send messages in it (text only for now).
    pub fn is_text(self) -> bool {
        matches!(self, Self::Text | Self::Announcement | Self::Dm | Self::GroupDm)
    }
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: Id,
    pub guild_id: Option<Id>,
    pub parent_id: Option<Id>,
    pub name: String,
    pub kind: ChannelKind,
    pub position: i64,
}

#[derive(Debug, Clone)]
pub struct Guild {
    pub id: Id,
    pub name: String,
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: Id,
    pub channel_id: Id,
    pub author: String,
    pub content: String,
    pub timestamp: String,
    pub edited: bool,
    pub attachments: usize,
}

#[derive(Debug, Clone)]
pub struct CurrentUser {
    #[allow(dead_code)] // used by upcoming features (mentions, own-message styling)
    pub id: Id,
    pub name: String,
}

pub fn snowflake(v: &Value) -> Option<Id> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64())
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn user_display(u: &Value) -> String {
    u.get("global_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| str_of(u, "username"))
}

pub fn parse_user(v: &Value) -> Option<CurrentUser> {
    Some(CurrentUser { id: snowflake(v.get("id")?)?, name: user_display(v) })
}

pub fn parse_channel(v: &Value, guild_id: Option<Id>) -> Option<Channel> {
    let kind = ChannelKind::from_type(v.get("type")?.as_u64()?);
    let mut name = str_of(v, "name");
    if name.is_empty() {
        // DMs have no name: build one from the recipients.
        if let Some(r) = v.get("recipients").and_then(Value::as_array) {
            name = r.iter().map(user_display).collect::<Vec<_>>().join(", ");
        }
    }
    Some(Channel {
        id: snowflake(v.get("id")?)?,
        guild_id: guild_id.or_else(|| v.get("guild_id").and_then(snowflake)),
        parent_id: v.get("parent_id").and_then(snowflake),
        name,
        kind,
        position: v.get("position").and_then(Value::as_i64).unwrap_or(0),
    })
}

pub fn parse_guild(v: &Value) -> Option<Guild> {
    let id = snowflake(v.get("id")?)?;
    // Newer gateway payloads nest the name under "properties".
    let mut name = str_of(v, "name");
    if name.is_empty() {
        name = v.get("properties").map(|p| str_of(p, "name")).unwrap_or_default();
    }
    let mut channels: Vec<Channel> = v
        .get("channels")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| parse_channel(c, Some(id))).collect())
        .unwrap_or_default();
    sort_channels(&mut channels);
    Some(Guild { id, name, channels })
}

/// Orders channels the way users expect: uncategorised first, then each
/// category followed by its children, all by position.
pub fn sort_channels(chs: &mut Vec<Channel>) {
    let mut cats: Vec<&Channel> = chs.iter().filter(|c| c.kind == ChannelKind::Category).collect();
    cats.sort_by_key(|c| (c.position, c.id));
    let children = |parent: Option<Id>| {
        let mut v: Vec<Channel> = chs
            .iter()
            .filter(|c| c.kind != ChannelKind::Category && c.parent_id == parent)
            .cloned()
            .collect();
        v.sort_by_key(|c| (c.kind == ChannelKind::Voice, c.position, c.id));
        v
    };
    let mut out = children(None);
    for cat in &cats {
        out.push((*cat).clone());
        out.extend(children(Some(cat.id)));
    }
    // Anything whose parent we do not know about goes at the end.
    let known: std::collections::HashSet<Id> = out.iter().map(|c| c.id).collect();
    out.extend(chs.iter().filter(|c| !known.contains(&c.id)).cloned());
    *chs = out;
}

pub fn parse_message(v: &Value) -> Option<Message> {
    Some(Message {
        id: snowflake(v.get("id")?)?,
        channel_id: snowflake(v.get("channel_id")?)?,
        author: v.get("author").map(user_display).unwrap_or_default(),
        content: str_of(v, "content"),
        timestamp: str_of(v, "timestamp"),
        edited: v.get("edited_timestamp").is_some_and(|t| !t.is_null()),
        attachments: v.get("attachments").and_then(Value::as_array).map_or(0, Vec::len),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_guild_with_properties_name() {
        let g = parse_guild(&json!({
            "id": "1", "properties": {"name": "Test"},
            "channels": [
                {"id": "3", "type": 0, "name": "general", "parent_id": "2", "position": 0},
                {"id": "2", "type": 4, "name": "Text", "position": 0},
                {"id": "4", "type": 0, "name": "top", "position": 0}
            ]
        }))
        .unwrap();
        assert_eq!(g.name, "Test");
        let order: Vec<_> = g.channels.iter().map(|c| c.id).collect();
        assert_eq!(order, vec![4, 2, 3]);
    }

    #[test]
    fn parses_message() {
        let m = parse_message(&json!({
            "id": "10", "channel_id": "3", "content": "hi", "timestamp": "t",
            "author": {"username": "a", "global_name": "A"}, "edited_timestamp": null
        }))
        .unwrap();
        assert_eq!(m.author, "A");
        assert!(!m.edited);
    }
}
