//! Settings saved on this PC (cache and persistence). They live in Harmony's config folder as
//! settings.json and never hold the token or anything from Discord.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::perf::{PerfSettings, Profile};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub auto_check_updates: bool,
    pub auto_install_updates: bool,
    pub profile: Profile,
    pub perf: PerfSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto_check_updates: true, auto_install_updates: false, profile: Profile::Balanced, perf: Profile::Balanced.preset() }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        let mut s: Settings = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        s.perf = s.perf.clamped();
        s.profile = Profile::of(&s.perf);
        s
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::to_string_pretty(self).unwrap_or_default());
    }

    /// Apply what the window sent. A new profile fills in its preset; a changed single setting
    /// keeps the others and makes the profile custom.
    pub fn merged(&self, incoming: Settings) -> Settings {
        let mut next = incoming;
        if next.profile != self.profile && next.profile != Profile::Custom {
            next.perf = next.profile.preset();
        }
        next.perf = next.perf.clamped();
        next.profile = Profile::of(&next.perf);
        next
    }
}

pub fn path(config_dir: Option<PathBuf>) -> PathBuf {
    config_dir.unwrap_or_else(|| PathBuf::from(".")).join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picking_a_profile_fills_its_preset() {
        let now = Settings::default();
        let next = now.merged(Settings { profile: Profile::Potato, ..now.clone() });
        assert_eq!(next.profile, Profile::Potato);
        assert_eq!(next.perf, Profile::Potato.preset());
    }

    #[test]
    fn changing_one_setting_keeps_the_rest() {
        let now = Settings::default();
        let mut sent = now.clone();
        sent.perf.channels_kept = 3;
        let next = now.merged(sent);
        assert_eq!(next.profile, Profile::Custom);
        assert_eq!(next.perf.channels_kept, 3);
        assert_eq!(next.perf.images, Profile::Balanced.preset().images);
    }

    #[test]
    fn old_settings_files_still_load() {
        let dir = std::env::temp_dir().join(format!("harmony-settings-test-{}", std::process::id()));
        let file = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, r#"{"auto_check_updates":false,"auto_install_updates":true}"#).unwrap();
        let s = Settings::load(&file);
        assert!(!s.auto_check_updates && s.auto_install_updates);
        assert_eq!(s.profile, Profile::Balanced);
        let _ = std::fs::remove_dir_all(dir);
    }
}
