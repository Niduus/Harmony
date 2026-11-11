//! Token handling. The account token is the single most sensitive thing this
//! client touches, so it lives in exactly two places: the OS keychain, and a
//! `Token` value in memory that refuses to print itself.

use std::fmt;

const KEYRING_SERVICE: &str = "harmony-discord-client";
const KEYRING_USER: &str = "account-token";

/// An account token. `Debug` and `Display` are redacted so it cannot end up
/// in logs, panics or error messages by accident.
#[derive(Clone)]
pub struct Token(String);

impl Token {
    /// Accepts a pasted token, trimming whitespace and stray quotes.
    pub fn parse(raw: &str) -> Option<Self> {
        let t = raw.trim().trim_matches('"').trim();
        // Bot tokens must never be used here, and "Bearer"/"Bot" prefixes mean
        // the wrong kind of credential was pasted.
        if t.is_empty() || t.contains(char::is_whitespace) || t.len() < 50 || t.len() > 200 {
            return None;
        }
        Some(Self(t.to_owned()))
    }

    /// The raw value. Only the gateway IDENTIFY and the REST auth header call this.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl Drop for Token {
    fn drop(&mut self) {
        // Best-effort wipe of the heap buffer before it is freed.
        // SAFETY: we overwrite bytes with zeros, which keeps the string valid UTF-8.
        unsafe {
            for b in self.0.as_bytes_mut() {
                std::ptr::write_volatile(b, 0);
            }
        }
    }
}

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
}

/// Loads the token from the OS keychain, if one was saved.
pub fn load() -> Result<Option<Token>, String> {
    let e = entry().map_err(|e| format!("keychain unavailable: {e}"))?;
    match e.get_password() {
        Ok(s) => Ok(Token::parse(&s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read keychain: {e}")),
    }
}

/// Saves the token to the OS keychain. This is the only place it is persisted.
pub fn save(token: &Token) -> Result<(), String> {
    entry()
        .and_then(|e| e.set_password(token.expose()))
        .map_err(|e| format!("could not save to keychain: {e}"))
}

/// Removes the token from the OS keychain (log out).
pub fn delete() -> Result<(), String> {
    match entry().and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not clear keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_never_prints() {
        let t = Token::parse(&"a".repeat(70)).unwrap();
        assert_eq!(format!("{t:?}"), "Token(<redacted>)");
        assert_eq!(format!("{t}"), "<redacted>");
    }

    #[test]
    fn rejects_garbage() {
        assert!(Token::parse("").is_none());
        assert!(Token::parse("short").is_none());
        assert!(Token::parse(&format!("Bot {}", "a".repeat(70))).is_none());
    }
}
