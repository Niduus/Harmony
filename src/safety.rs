//! Account-safety guardrails. Everything here exists to make the client behave
//! like a careful human using an ordinary client: no automation, no bursts, no
//! hammering endpoints that keep failing.
//!
//! These limits are deliberately stricter than Discord's published ones. Do
//! not loosen them without the project owner's explicit approval.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Hard cap on outgoing messages: at most this many...
pub const SEND_MAX_IN_WINDOW: usize = 5;
/// ...within this window (all channels combined).
pub const SEND_WINDOW: Duration = Duration::from_secs(5);
/// Discord's own message length limit for non-Nitro accounts.
pub const MAX_MESSAGE_LEN: usize = 2000;
/// Messages fetched when a channel is opened. One page, never paginated in bulk.
pub const HISTORY_PAGE: u32 = 50;
/// Messages kept per channel in memory.
pub const MAX_CACHED_PER_CHANNEL: usize = 500;

/// If REST gets this many 401/403/429 responses in `INVALID_WINDOW`, all REST
/// traffic stops until restart. Discord temporarily bans IPs at 10,000/10 min;
/// we stop at a tiny fraction of that.
pub const INVALID_LIMIT: usize = 25;
pub const INVALID_WINDOW: Duration = Duration::from_secs(600);

/// Gateway IDENTIFY attempts allowed per hour. Each one is a full login, and
/// repeated logins are a classic abuse signal.
pub const IDENTIFY_MAX_PER_HOUR: usize = 6;
/// Consecutive failed gateway connections before giving up and asking the user.
pub const MAX_RECONNECT_ATTEMPTS: u32 = 8;

/// Sliding-window counter used for all of the limits above.
#[derive(Debug)]
pub struct Window {
    max: usize,
    span: Duration,
    hits: VecDeque<Instant>,
}

impl Window {
    pub fn new(max: usize, span: Duration) -> Self {
        Self { max, span, hits: VecDeque::with_capacity(max + 1) }
    }

    fn prune(&mut self, now: Instant) {
        while self.hits.front().is_some_and(|t| now.duration_since(*t) >= self.span) {
            self.hits.pop_front();
        }
    }

    /// Records a hit if there is room and returns true, otherwise returns false.
    pub fn try_hit(&mut self) -> bool {
        let now = Instant::now();
        self.prune(now);
        if self.hits.len() >= self.max {
            return false;
        }
        self.hits.push_back(now);
        true
    }

    /// Records a hit unconditionally and reports whether the limit is now exceeded.
    pub fn hit_and_check_exceeded(&mut self) -> bool {
        let now = Instant::now();
        self.prune(now);
        self.hits.push_back(now);
        self.hits.len() > self.max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_caps_hits() {
        let mut w = Window::new(2, Duration::from_secs(60));
        assert!(w.try_hit());
        assert!(w.try_hit());
        assert!(!w.try_hit());
    }

    #[test]
    fn window_reports_exceeded() {
        let mut w = Window::new(1, Duration::from_secs(60));
        assert!(!w.hit_and_check_exceeded());
        assert!(w.hit_and_check_exceeded());
    }
}
