//! Notices when a meeting app starts using the microphone, so Atelier can offer to take notes.
//!
//! Windows records which apps currently hold the microphone in the privacy store
//! (`HKCU\…\CapabilityAccessManager\ConsentStore\microphone`): an app whose
//! `LastUsedTimeStop` is 0 is using it right now. One registry read every few seconds covers
//! Zoom, Teams and browser meetings (Google Meet) alike, without hooking into those apps.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::meeting_audio::Out;

const POLL: Duration = Duration::from_secs(3);
/// The mic must stay in use for this many polls before Atelier asks (ignores quick mic tests).
const START_POLLS: u32 = 2;
/// The meeting counts as over once the app released the mic for this long.
const END_AFTER: Duration = Duration::from_secs(20);

/// Maps a privacy-store key to (app id, display name) for meeting apps; everything else is ignored.
pub fn classify(key: &str, own_exe: Option<&str>) -> Option<(&'static str, &'static str)> {
    let lower = key.to_lowercase();
    // Non-packaged apps are stored as their path with '#' for '\'.
    let exe = lower.rsplit('#').next().unwrap_or(&lower);
    if own_exe.is_some_and(|own| exe == own) {
        return None;
    }
    if lower.starts_with("msteams_") || lower.starts_with("microsoftteams") {
        return Some(("teams", "Microsoft Teams"));
    }
    Some(match exe {
        "zoom.exe" | "cpthost.exe" | "zoomwebviewhost.exe" => ("zoom", "Zoom"),
        "ms-teams.exe" | "teams.exe" | "msteams.exe" => ("teams", "Microsoft Teams"),
        "chrome.exe" => ("browser", "Google Chrome"),
        "msedge.exe" => ("browser", "Microsoft Edge"),
        "brave.exe" => ("browser", "Brave"),
        "firefox.exe" => ("browser", "Firefox"),
        "opera.exe" => ("browser", "Opera"),
        "vivaldi.exe" => ("browser", "Vivaldi"),
        "arc.exe" => ("browser", "Arc"),
        "ciscocollabhost.exe" | "webexmta.exe" | "webex.exe" | "atmgr.exe" => ("webex", "Webex"),
        "slack.exe" => ("slack", "Slack"),
        "skype.exe" => ("skype", "Skype"),
        _ => return None,
    })
}

#[cfg(windows)]
fn active_apps(own_exe: Option<&str>) -> HashMap<&'static str, &'static str> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let mut found = HashMap::new();
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone",
    ) else {
        return found;
    };
    let mut visit = |key: &RegKey, name: &str| {
        let start: u64 = key.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = key.get_value("LastUsedTimeStop").unwrap_or(1);
        if start > 0 && stop == 0 {
            if let Some((id, label)) = classify(name, own_exe) {
                found.entry(id).or_insert(label);
            }
        }
    };
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else { continue };
        if name.eq_ignore_ascii_case("NonPackaged") {
            for sub in key.enum_keys().flatten() {
                if let Ok(app) = key.open_subkey(&sub) {
                    visit(&app, &sub);
                }
            }
        } else {
            visit(&key, &name);
        }
    }
    found
}

#[cfg(not(windows))]
fn active_apps(_own_exe: Option<&str>) -> HashMap<&'static str, &'static str> {
    HashMap::new()
}

/// Starts the watcher thread. It only reads the registry while `enabled` is set.
pub fn spawn(enabled: Arc<AtomicBool>, out: Out) {
    let own_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    let _ = std::thread::Builder::new().name("meeting-detect".into()).spawn(move || {
        let mut candidates: HashMap<&'static str, u32> = HashMap::new();
        // Apps the user was told about, with the last time they were seen using the mic.
        let mut announced: HashMap<&'static str, (&'static str, Instant)> = HashMap::new();
        let send = |state: &str, id: &str, name: &str| {
            out(format!("meeting-app {}", json!({ "state": state, "appId": id, "appName": name })));
        };

        loop {
            std::thread::sleep(POLL);
            if !enabled.load(Ordering::SeqCst) {
                candidates.clear();
                announced.clear();
                continue;
            }
            let active = active_apps(own_exe.as_deref());
            let now = Instant::now();

            for (&id, &name) in &active {
                if let Some(entry) = announced.get_mut(id) {
                    entry.1 = now;
                    continue;
                }
                let polls = candidates.entry(id).or_insert(0);
                *polls += 1;
                if *polls >= START_POLLS {
                    candidates.remove(id);
                    announced.insert(id, (name, now));
                    send("started", id, name);
                }
            }
            candidates.retain(|id, _| active.contains_key(id));

            let ended: Vec<(&'static str, &'static str)> = announced
                .iter()
                .filter(|(id, (_, last))| !active.contains_key(*id) && now.duration_since(*last) >= END_AFTER)
                .map(|(&id, &(name, _))| (id, name))
                .collect();
            for (id, name) in ended {
                announced.remove(id);
                send("ended", id, name);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn recognises_meeting_apps() {
        assert_eq!(classify(r"C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe", None).unwrap().0, "zoom");
        assert_eq!(classify("MSTeams_8wekyb3d8bbwe", None).unwrap().0, "teams");
        assert_eq!(
            classify(r"C:#Program Files#Google#Chrome#Application#chrome.exe", None).unwrap(),
            ("browser", "Google Chrome")
        );
    }

    #[test]
    fn ignores_games_and_itself() {
        assert!(classify(r"C:#Games#dota2.exe", None).is_none());
        assert!(classify(r"C:#Users#me#AppData#Local#Discord#app-1#Discord.exe", None).is_none());
        assert!(classify(r"C:#Program Files#Atelier#atelier.exe", Some("atelier.exe")).is_none());
    }
}
