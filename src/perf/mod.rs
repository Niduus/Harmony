//! Performance: the Potato / Balanced / Enthusiast profiles and the memory meter.
//!
//! A profile is only a preset. Picking one fills in every setting in [`PerfSettings`]; you can
//! then change any single setting, which makes the profile "custom". Nothing here touches
//! Discord or the safety limits.

pub mod memory;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Potato,
    #[default]
    Balanced,
    Enthusiast,
    Custom,
}

/// When images and avatars load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Images {
    Click,
    Visible,
    Prefetch,
}

/// When GIFs and animated emoji move.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Animate {
    Hover,
    Visible,
    Always,
}

/// Interface animations and transitions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Motion {
    Off,
    Short,
    Full,
}

/// What Harmony does while minimised or hidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Idle {
    Stop,
    Throttle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PerfSettings {
    pub messages_per_channel: u32,
    pub channels_kept: u32,
    pub images: Images,
    pub animate: Animate,
    pub embeds: bool,
    pub motion: Motion,
    pub idle: Idle,
}

impl Default for PerfSettings {
    fn default() -> Self {
        Profile::Balanced.preset()
    }
}

/// Bounds for the settings people can type. The message cap can never exceed the
/// per-channel cache limit in safety.rs.
pub const MESSAGES_RANGE: (u32, u32) = (50, crate::safety::MAX_CACHED_PER_CHANNEL as u32);
pub const CHANNELS_RANGE: (u32, u32) = (1, 30);

impl Profile {
    pub fn preset(self) -> PerfSettings {
        let max_messages = MESSAGES_RANGE.1;
        match self {
            Profile::Potato => PerfSettings {
                messages_per_channel: 100,
                channels_kept: 2,
                images: Images::Click,
                animate: Animate::Hover,
                embeds: false,
                motion: Motion::Off,
                idle: Idle::Stop,
            },
            Profile::Balanced | Profile::Custom => PerfSettings {
                messages_per_channel: 300.min(max_messages),
                channels_kept: 10,
                images: Images::Visible,
                animate: Animate::Visible,
                embeds: true,
                motion: Motion::Short,
                idle: Idle::Stop,
            },
            Profile::Enthusiast => PerfSettings {
                messages_per_channel: max_messages,
                channels_kept: 30,
                images: Images::Prefetch,
                animate: Animate::Always,
                embeds: true,
                motion: Motion::Full,
                idle: Idle::Throttle,
            },
        }
    }

    /// The profile whose preset matches these settings exactly, or Custom.
    pub fn of(settings: &PerfSettings) -> Profile {
        [Profile::Potato, Profile::Balanced, Profile::Enthusiast]
            .into_iter()
            .find(|p| p.preset() == *settings)
            .unwrap_or(Profile::Custom)
    }
}

impl PerfSettings {
    /// Keep typed numbers inside their bounds.
    pub fn clamped(mut self) -> Self {
        self.messages_per_channel = self.messages_per_channel.clamp(MESSAGES_RANGE.0, MESSAGES_RANGE.1);
        self.channels_kept = self.channels_kept.clamp(CHANNELS_RANGE.0, CHANNELS_RANGE.1);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_preset_is_recognised_as_its_profile() {
        for p in [Profile::Potato, Profile::Balanced, Profile::Enthusiast] {
            assert_eq!(Profile::of(&p.preset()), p);
        }
    }

    #[test]
    fn a_changed_setting_makes_the_profile_custom() {
        let mut s = Profile::Potato.preset();
        s.embeds = true;
        assert_eq!(Profile::of(&s), Profile::Custom);
    }

    #[test]
    fn presets_stay_inside_the_safety_cache_limit() {
        for p in [Profile::Potato, Profile::Balanced, Profile::Enthusiast] {
            let s = p.preset();
            assert_eq!(s.clone().clamped(), s);
        }
        let big = PerfSettings { messages_per_channel: 1_000_000, channels_kept: 0, ..Profile::Balanced.preset() }.clamped();
        assert_eq!(big.messages_per_channel, MESSAGES_RANGE.1);
        assert_eq!(big.channels_kept, CHANNELS_RANGE.0);
    }
}
