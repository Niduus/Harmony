//! The memory meter: how much private memory Harmony and its WebView2 helper processes use.
//!
//! "Private" memory is what belongs to these processes alone (shared system libraries are
//! left out), so adding the processes together doesn't double count.

use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Usage {
    /// Harmony.exe itself (the Rust core).
    pub core_bytes: u64,
    /// The window's WebView2 processes (browser, renderer, GPU, utility).
    pub window_bytes: u64,
    pub total_bytes: u64,
    /// How many processes were counted, Harmony included.
    pub processes: u32,
}

/// Measure now. Takes a few milliseconds; the window asks every couple of seconds at most,
/// and only while the meter is on screen.
pub fn usage() -> Usage {
    let me = std::process::id();
    let all = platform::processes();
    let mut family = vec![me];
    // Walk down the process tree: WebView2's processes are Harmony's children and grandchildren.
    let mut i = 0;
    while i < family.len() {
        let parent = family[i];
        for &(pid, ppid) in &all {
            if ppid == parent && pid != parent && !family.contains(&pid) {
                family.push(pid);
            }
        }
        i += 1;
    }
    let mut usage = Usage::default();
    for &(pid, _) in all.iter().filter(|(pid, _)| family.contains(pid)) {
        let bytes = platform::private_bytes(pid);
        if pid == me {
            usage.core_bytes += bytes;
        } else {
            usage.window_bytes += bytes;
        }
        usage.processes += 1;
    }
    usage.total_bytes = usage.core_bytes + usage.window_bytes;
    usage
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    /// (pid, parent pid) for every running process.
    pub fn processes() -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snap, &mut entry) != 0;
            while more {
                out.push((entry.th32ProcessID, entry.th32ParentProcessID));
                more = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
        }
        out
    }

    pub fn private_bytes(pid: u32) -> u64 {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return 0;
            }
            let mut counters: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let ok = GetProcessMemoryInfo(process, &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS, counters.cb) != 0;
            CloseHandle(process);
            if ok {
                counters.PrivateUsage as u64
            } else {
                0
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    /// (pid, parent pid) for every running process.
    pub fn processes() -> Vec<(u32, u32)> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| {
                let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
                // The name in brackets may contain spaces; the fields after ") " are fixed.
                let ppid = stat.rsplit_once(") ")?.1.split_whitespace().nth(1)?.parse().ok()?;
                Some((pid, ppid))
            })
            .collect()
    }

    pub fn private_bytes(pid: u32) -> u64 {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
        status
            .lines()
            .find_map(|l| l.strip_prefix("RssAnon:"))
            .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            .map_or(0, |kb| kb * 1024)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    pub fn processes() -> Vec<(u32, u32)> {
        Vec::new()
    }
    pub fn private_bytes(_pid: u32) -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_meter_counts_this_process() {
        let u = usage();
        if cfg!(any(windows, target_os = "linux")) {
            assert!(u.processes >= 1);
            assert!(u.core_bytes > 0);
            assert_eq!(u.total_bytes, u.core_bytes + u.window_bytes);
        }
    }
}
