//! Authentication: the token type, its keychain storage, and the "Sign in with Discord" window.
//! Nothing outside this module and `discord/` ever reads the raw token.

pub mod login_window;
pub mod token;
