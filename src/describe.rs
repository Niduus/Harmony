//! Turns a raw Discord message into the shape the chat view draws (the same shape hbv's
//! panel uses, so its chat code works unchanged).
//!
//! Every action flag (canEdit, canDelete, canPin) is false in Phase 1: Harmony only reads
//! and sends plain messages until each action gets its own safety limits.

use serde_json::{json, Map, Value};

use crate::store::{sf, snowflake, snowflake_ms, text, Id, Store, User};

/// Message types that read like ordinary chat: default, reply, slash command, context menu.
const NORMAL_TYPES: [u64; 4] = [0, 19, 20, 23];

fn system_text(kind: u64, author: &str) -> String {
    match kind {
        1 => format!("{author} added someone to the group."),
        2 => format!("{author} removed someone from the group."),
        3 => format!("{author} started a call."),
        4 => format!("{author} changed the channel name."),
        5 => format!("{author} changed the channel icon."),
        6 => format!("{author} pinned a message to this channel."),
        7 => format!("{author} joined the server."),
        8 => format!("{author} boosted the server."),
        9..=11 => format!("{author} boosted the server to a new level."),
        12 => format!("{author} added a channel follow."),
        18 => format!("{author} started a thread."),
        _ => "System message".into(),
    }
}

fn display_name(v: &Value, member: Option<&Value>) -> String {
    if let Some(nick) = member.and_then(|m| m.get("nick")).and_then(Value::as_str).filter(|n| !n.is_empty()) {
        return nick.to_owned();
    }
    User::parse(v).map(|u| u.name()).unwrap_or_else(|| "Unknown".into())
}

fn mentions(raw: &Value, store: &Store, guild_id: Option<Id>) -> Value {
    let mut users = Map::new();
    for u in raw["mentions"].as_array().into_iter().flatten() {
        if let Some(id) = sf(u, "id") {
            users.insert(id.to_string(), json!(display_name(u, u.get("member"))));
        }
    }
    // Mentions the payload did not include, but Harmony already knows the person.
    let content = raw["content"].as_str().unwrap_or_default();
    for part in content.split("<@").skip(1) {
        let digits: String = part.trim_start_matches('!').chars().take_while(char::is_ascii_digit).collect();
        if let Ok(id) = digits.parse::<Id>() {
            if !users.contains_key(&digits) {
                if let Some(u) = store.users.get(&id) {
                    users.insert(digits, json!(u.name()));
                }
            }
        }
    }
    let mut roles = Map::new();
    let mut role_colors = Map::new();
    if let Some(g) = guild_id.and_then(|g| store.guilds.get(&g)) {
        for id in raw["mention_roles"].as_array().into_iter().flatten().filter_map(snowflake) {
            if let Some(r) = g.roles.get(&id) {
                roles.insert(id.to_string(), json!(r.name));
                if r.color != 0 {
                    role_colors.insert(id.to_string(), json!(format!("#{:06x}", r.color)));
                }
            }
        }
    }
    let mut channels = Map::new();
    for part in content.split("<#").skip(1) {
        let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
        if let Some(name) = digits.parse::<Id>().ok().and_then(|id| store.channel_name(id)) {
            channels.insert(digits, json!(name));
        }
    }
    json!({ "users": users, "roles": roles, "roleColors": role_colors, "channels": channels })
}

fn attachments(raw: &Value) -> Vec<Value> {
    raw["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            let name = text(a, "filename");
            json!({
                "id": text(a, "id"),
                "name": if name.is_empty() { "file".to_owned() } else { name.clone() },
                "url": text(a, "url"),
                "proxyUrl": text(a, "proxy_url"),
                "contentType": text(a, "content_type"),
                "size": a["size"].as_u64().unwrap_or(0),
                "width": a["width"].as_u64().unwrap_or(0),
                "height": a["height"].as_u64().unwrap_or(0),
                "spoiler": name.starts_with("SPOILER_"),
            })
        })
        .collect()
}

fn stickers(raw: &Value) -> Vec<Value> {
    raw["sticker_items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            // Format 3 is an animated Lottie file, which the chat can't draw; it shows the name.
            let url = if s["format_type"].as_u64() == Some(3) { String::new() } else { format!("https://media.discordapp.net/stickers/{}.png?size=160", text(s, "id")) };
            json!({ "name": text(s, "name"), "url": url })
        })
        .collect()
}

/// A short line about a message, for reply previews.
fn brief(raw: &Value, store: &Store, guild_id: Option<Id>) -> Value {
    let author = &raw["author"];
    let user = User::parse(author).unwrap_or_default();
    json!({
        "id": text(raw, "id"),
        "authorId": user.id.to_string(),
        "authorName": display_name(author, raw.get("member")),
        "authorAvatar": user.avatar_url(),
        "content": raw["content"].as_str().unwrap_or_default().chars().take(300).collect::<String>(),
        "mentions": mentions(raw, store, guild_id),
        "attachment": raw["attachments"].as_array().is_some_and(|a| !a.is_empty()),
    })
}

pub fn message(raw: &Value, store: &Store) -> Option<Value> {
    let id = sf(raw, "id")?;
    let channel_id = sf(raw, "channel_id")?;
    let guild_id = sf(raw, "guild_id").or_else(|| store.channel(channel_id).and_then(|c| c.guild_id));
    let author = &raw["author"];
    let user = User::parse(author).unwrap_or_default();
    let me = store.me_id();
    let kind = raw["type"].as_u64().unwrap_or(0);
    let normal = NORMAL_TYPES.contains(&kind);
    let name = display_name(author, raw.get("member"));
    let reply_to = if kind == 19 { raw["message_reference"].get("message_id").and_then(snowflake) } else { None };
    let reply = match (&raw["referenced_message"], reply_to) {
        (r, Some(_)) if r.is_object() => brief(r, store, guild_id),
        (_, Some(rid)) => json!({ "id": rid.to_string(), "missing": true }),
        _ => Value::Null,
    };
    let interaction = raw.get("interaction_metadata").or_else(|| raw.get("interaction")).filter(|i| i.is_object()).map(|i| {
        let who = i.get("user").map(|u| display_name(u, None)).unwrap_or_default();
        json!({ "userName": who, "command": text(i, "name") })
    });
    let mentioned = raw["mention_everyone"].as_bool().unwrap_or(false)
        || raw["mentions"].as_array().into_iter().flatten().any(|u| sf(u, "id") == Some(me));
    let mut out = json!({
        "id": id.to_string(),
        "channelId": channel_id.to_string(),
        "fromBot": user.id == me && me != 0,
        "authorId": user.id.to_string(),
        "authorName": name,
        "authorBot": user.bot,
        "authorAvatar": user.avatar_url(),
        "content": raw["content"].as_str().unwrap_or_default(),
        "mentions": mentions(raw, store, guild_id),
        "attachments": attachments(raw),
        // Embeds and reactions are drawn from Phase 2 on.
        "embeds": [],
        "embedCards": [],
        "stickers": stickers(raw),
        "reactions": [],
        "createdAt": snowflake_ms(id),
        "edited": raw["edited_timestamp"].is_string(),
        "pinned": raw["pinned"].as_bool().unwrap_or(false),
        "type": if kind == 19 { "reply" } else if normal { "default" } else { "system" },
        "system": if normal { String::new() } else { system_text(kind, &name) },
        "replyTo": reply_to.map(|r| r.to_string()).unwrap_or_default(),
        "interaction": interaction,
        "mentionsBot": user.id != me && mentioned,
        "canEdit": false,
        "canDelete": false,
        "canPin": false,
        "editText": "",
        "editStyle": "plain",
        "achievement": false,
        "nonce": raw.get("nonce").map(|n| n.as_str().map(str::to_owned).unwrap_or_else(|| n.to_string())).unwrap_or_default(),
    });
    if !reply.is_null() {
        out["reply"] = reply;
    }
    Some(out)
}

/// A one-line preview of a message for the DM list.
pub fn preview(raw: &Value) -> String {
    let content = raw["content"].as_str().unwrap_or_default();
    if !content.is_empty() {
        return content.chars().take(120).collect();
    }
    if raw["attachments"].as_array().is_some_and(|a| !a.is_empty()) {
        return "Sent an attachment".into();
    }
    if raw["sticker_items"].as_array().is_some_and(|a| !a.is_empty()) {
        return "Sent a sticker".into();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_reply() {
        let mut store = Store::default();
        store.me = User::parse(&json!({"id": "1", "username": "me"}));
        let m = message(
            &json!({
                "id": "1100000000000000000", "channel_id": "5", "type": 19, "content": "hi <@1>",
                "author": {"id": "2", "username": "a", "global_name": "Alice"},
                "mentions": [{"id": "1", "username": "me"}],
                "message_reference": {"message_id": "1000000000000000000"},
                "referenced_message": {"id": "1000000000000000000", "content": "first", "author": {"id": "1", "username": "me"}},
                "edited_timestamp": null, "nonce": "abc"
            }),
            &store,
        )
        .unwrap();
        assert_eq!(m["authorName"], "Alice");
        assert_eq!(m["type"], "reply");
        assert_eq!(m["reply"]["content"], "first");
        assert_eq!(m["mentionsBot"], true);
        assert_eq!(m["fromBot"], false);
        assert_eq!(m["canDelete"], false);
        assert_eq!(m["nonce"], "abc");
        assert_eq!(m["mentions"]["users"]["1"], "me");
    }

    #[test]
    fn system_message() {
        let store = Store::default();
        let m = message(&json!({"id": "1", "channel_id": "2", "type": 7, "author": {"id": "3", "username": "bob"}}), &store).unwrap();
        assert_eq!(m["type"], "system");
        assert_eq!(m["system"], "bob joined the server.");
    }
}
