//! Running photo_stitcher.py: one run at a time, cancellable, killed on app exit.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

use crate::project::{self, ProjectState};
use crate::{lock, python, AppState};

pub const SCRIPT_RESOURCE: &str = "python/photo_stitcher.py";
/// Exact text the frontend compares against (STITCH_CANCELLED).
pub const CANCELLED: &str = "Stitching cancelled";
const POLL: Duration = Duration::from_millis(100);
const TAIL_LINES: usize = 40;
const MAX_MESSAGE_CHARS: usize = 500;

/// Payload of the "stitch-log" event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StitchLog<'a> {
    run_id: u64,
    line: &'a str,
}

#[derive(Default)]
struct Slot {
    running: bool,
    cancelled: bool,
    child: Option<Arc<Mutex<Child>>>,
}

/// Shared state of the (single) stitch run.
#[derive(Default)]
pub struct StitchState {
    slot: Mutex<Slot>,
}

/// Marks the run as finished when dropped, whatever way the run ends.
pub struct RunGuard<'a> {
    state: &'a StitchState,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.state.slot) = Slot::default();
    }
}

impl StitchState {
    fn slot(&self) -> MutexGuard<'_, Slot> {
        lock(&self.slot)
    }

    pub fn is_running(&self) -> bool {
        self.slot().running
    }

    pub fn try_begin(&self) -> Result<RunGuard<'_>, String> {
        let mut slot = self.slot();
        if slot.running {
            return Err("A stitch is already running".into());
        }
        *slot = Slot {
            running: true,
            ..Slot::default()
        };
        Ok(RunGuard { state: self })
    }

    pub fn is_cancelled(&self) -> bool {
        self.slot().cancelled
    }

    /// Registers the spawned child so it can be cancelled. If a cancel already arrived,
    /// the child is killed right away.
    fn attach(&self, child: Child) -> Arc<Mutex<Child>> {
        let child = Arc::new(Mutex::new(child));
        let mut slot = self.slot();
        if slot.cancelled {
            let _ = lock(&child).kill();
        }
        slot.child = Some(child.clone());
        child
    }

    /// Kills the running stitch. Returns true if one was running.
    pub fn cancel(&self) -> bool {
        let child = {
            let mut slot = self.slot();
            if !slot.running {
                return false;
            }
            slot.cancelled = true;
            slot.child.clone()
        };
        if let Some(child) = child {
            let _ = lock(&child).kill();
        }
        true
    }

    /// Used on app exit: kill and reap the child so no Python is left behind.
    pub fn kill_running(&self) {
        let child = {
            let mut slot = self.slot();
            slot.cancelled = true;
            slot.child.clone()
        };
        if let Some(child) = child {
            let mut c = lock(&child);
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Waits for `child`, killing it if it takes longer than `timeout` or `stop` returns
/// true. None on timeout/stop/error.
pub fn wait_with_timeout(
    child: &mut Child,
    timeout: Duration,
    stop: &dyn Fn() -> bool,
) -> Option<ExitStatus> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if start.elapsed() < timeout && !stop() => thread::sleep(POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn wait_shared(child: &Mutex<Child>) -> std::io::Result<ExitStatus> {
    loop {
        if let Some(status) = lock(child).try_wait()? {
            return Ok(status);
        }
        thread::sleep(POLL);
    }
}

/// Reads `pipe` line by line (lossy UTF-8; `\r`-separated progress updates become
/// separate lines) and calls `f` for every non-empty line until EOF.
fn for_each_line<R: Read>(pipe: R, mut f: impl FnMut(&str)) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                for part in text.split('\r') {
                    let line = part.trim_end();
                    if !line.trim().is_empty() {
                        f(line);
                    }
                }
            }
        }
    }
}

/// Remembers what is needed from stderr to explain a failure.
#[derive(Default)]
pub struct StderrSummary {
    last_error: Option<String>,
    tail: VecDeque<String>,
}

impl StderrSummary {
    pub fn push(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        if let Some(msg) = trimmed.strip_prefix("ERROR: ") {
            let msg = msg.trim();
            if !msg.is_empty() {
                self.last_error = Some(msg.to_string());
            }
        }
        if self.tail.len() == TAIL_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(trimmed.to_string());
    }

    pub fn tail(&self) -> impl Iterator<Item = &str> {
        self.tail.iter().map(String::as_str)
    }

    /// One line for the user: the last "ERROR: " message, else the last non-empty stderr
    /// line, else the exit status.
    pub fn failure_message(&self, status: &str) -> String {
        let msg = self
            .last_error
            .clone()
            .or_else(|| self.tail.back().cloned())
            .unwrap_or_else(|| format!("Stitching failed ({status})"));
        truncate_chars(&msg, MAX_MESSAGE_CHARS)
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

pub fn describe_status(status: &ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exit status {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return format!("killed by signal {sig}");
        }
    }
    "exit status unknown".into()
}

fn cached_python(state: &AppState, log: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let mut cache = lock(&state.python);
    if let Some(p) = cache.as_ref() {
        return Ok(p.clone());
    }
    log("Looking for a Python with the stitching packages…");
    // A cancel (or app exit) stops the probing; nothing is cached then.
    let found = python::find_python(&|| state.stitch.is_cancelled())?;
    *cache = Some(found.clone());
    Ok(found)
}

/// Identifies a version of a file: Python replaces result.json atomically (new inode,
/// new mtime), so any commit changes this.
type FileIdentity = (Option<SystemTime>, u64, u64);

fn file_identity(path: &Path) -> Option<FileIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(&meta);
    #[cfg(not(unix))]
    let ino = 0;
    Some((meta.modified().ok(), meta.len(), ino))
}

fn script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let script = app
        .path()
        .resolve(SCRIPT_RESOURCE, BaseDirectory::Resource)
        .map_err(|e| format!("Could not locate the stitching script: {e}"))?;
    if !script.is_file() {
        return Err(format!(
            "The stitching script is missing ({})",
            script.display()
        ));
    }
    Ok(script)
}

/// Runs a whole stitch (blocking). Called on a blocking thread by the command.
pub fn run(app: &AppHandle, run_id: u64) -> Result<ProjectState, String> {
    let state = app.state::<AppState>();
    let guard = state.stitch.try_begin()?;

    let dir = crate::data_dir(app)?;
    let images = {
        let _project = lock(&state.project_lock);
        // Leftovers of a killed run (SIGKILL leaves Python no chance to clean up). Safe:
        // pick_images/clear_project are refused while a stitch runs.
        project::cleanup_temp_files(&dir);
        project::load_images(&dir)
    };
    if images.len() < 2 {
        return Err("Select at least two images to stitch".into());
    }
    // Python writes result.json last and only on success, so a changed result.json
    // after the run means this run committed a new panorama.
    let result_file = dir.join(project::RESULT_FILE);
    let result_before = file_identity(&result_file);
    let input = dir.join(project::STITCH_INPUT_FILE);
    project::write_image_list(&input, &images)
        .map_err(|e| format!("Could not write the stitch input: {e}"))?;

    let emit = |line: &str| {
        let _ = app.emit("stitch-log", StitchLog { run_id, line });
    };
    let python = cached_python(&state, &emit)?;
    let script = script_path(app)?;
    if state.stitch.is_cancelled() {
        return Err(CANCELLED.into());
    }
    emit(&format!("Stitching {} images…", images.len()));

    let spawned = Command::new(&python)
        .arg("-u")
        .arg(&script)
        .arg("--input")
        .arg(&input)
        .arg("--output-dir")
        .arg(&dir)
        .current_dir(&dir)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            // The cached interpreter may have been removed; look again next time.
            *lock(&state.python) = None;
            return Err(format!("Could not start {}: {e}", python.display()));
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = state.stitch.attach(child);

    // Each pipe on its own thread so neither can fill up and block the script.
    let out_thread = stdout.map(|pipe| {
        let app = app.clone();
        thread::spawn(move || {
            for_each_line(pipe, |line| {
                let _ = app.emit("stitch-log", StitchLog { run_id, line });
            })
        })
    });
    let err_thread = stderr.map(|pipe| {
        let app = app.clone();
        thread::spawn(move || {
            let mut summary = StderrSummary::default();
            for_each_line(pipe, |line| {
                summary.push(line);
                let _ = app.emit("stitch-log", StitchLog { run_id, line });
            });
            summary
        })
    });

    let status = wait_shared(&child);
    if let Some(t) = out_thread {
        let _ = t.join();
    }
    let summary = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let status = status.map_err(|e| format!("Lost track of the stitcher: {e}"))?;

    // A cancel or kill that lands after the commit (e.g. during interpreter teardown)
    // must not report "cancelled" while a new panorama is on disk.
    let committed =
        file_identity(&result_file) != result_before && project::load_panorama(&dir).is_some();
    if !committed {
        project::cleanup_temp_files(&dir);
        if state.stitch.is_cancelled() {
            return Err(CANCELLED.into());
        }
        if !status.success() {
            let desc = describe_status(&status);
            eprintln!("[stitcher] failed ({desc}); stderr tail:");
            for line in summary.tail() {
                eprintln!("[stitcher]   {line}");
            }
            return Err(summary.failure_message(&desc));
        }
        return Err("Stitching finished but no panorama was produced".into());
    }
    drop(guard);
    Ok(crate::project_state(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(lines: &[&str]) -> StderrSummary {
        let mut s = StderrSummary::default();
        for l in lines {
            s.push(l);
        }
        s
    }

    #[test]
    fn error_line_wins() {
        let s = summary(&[
            "Loading 12 images",
            "ERROR: first problem",
            "ERROR: Could not find enough overlap between the photos.",
            "",
        ]);
        assert_eq!(
            s.failure_message("exit status 2"),
            "Could not find enough overlap between the photos."
        );
    }

    #[test]
    fn falls_back_to_last_line_then_status() {
        let s = summary(&[
            "Traceback (most recent call last):",
            "  File \"x.py\", line 1, in <module>",
            "ValueError: boom",
            "   ",
        ]);
        assert_eq!(s.failure_message("exit status 1"), "ValueError: boom");
        let s = summary(&[]);
        assert_eq!(
            s.failure_message("exit status 3"),
            "Stitching failed (exit status 3)"
        );
        // "ERROR:" without a message is not an error line.
        let s = summary(&["ERROR: "]);
        assert_eq!(s.failure_message("exit status 2"), "ERROR:");
    }

    #[test]
    fn tail_is_bounded_and_messages_truncated() {
        let mut s = StderrSummary::default();
        for i in 0..100 {
            s.push(&format!("line {i}"));
        }
        assert_eq!(s.tail().count(), TAIL_LINES);
        assert_eq!(s.tail().last(), Some("line 99"));
        let long = "x".repeat(MAX_MESSAGE_CHARS + 10);
        let s = summary(&[&format!("ERROR: {long}")]);
        assert_eq!(s.failure_message("").chars().count(), MAX_MESSAGE_CHARS + 1);
    }

    #[test]
    fn line_splitting() {
        let input: &[u8] = b"one\r\ntwo\rthree\n\n  \nbad \xff byte\nlast";
        let mut lines = Vec::new();
        for_each_line(input, |l| lines.push(l.to_string()));
        assert_eq!(lines, ["one", "two", "three", "bad \u{fffd} byte", "last"]);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_child() {
        let state = StitchState::default();
        assert!(!state.cancel(), "nothing running");
        let guard = state.try_begin().unwrap();
        assert!(state.try_begin().is_err(), "one at a time");
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let child = state.attach(child);
        assert!(state.cancel());
        let status = wait_shared(&child).unwrap();
        assert!(!status.success());
        assert!(state.is_cancelled());
        drop(guard);
        assert!(!state.is_running());
        assert!(!state.is_cancelled());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_child() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        assert!(wait_with_timeout(&mut child, Duration::from_millis(200), &|| false).is_none());
        let mut child = Command::new("true").spawn().unwrap();
        assert!(
            wait_with_timeout(&mut child, Duration::from_secs(10), &|| false)
                .unwrap()
                .success()
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_child() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let start = Instant::now();
        assert!(wait_with_timeout(&mut child, Duration::from_secs(60), &|| true).is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(child.try_wait().unwrap().is_some(), "child reaped");
    }

    #[test]
    fn file_identity_changes_on_replace() {
        let dir = std::env::temp_dir().join(format!("terra-ident-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(project::RESULT_FILE);
        let _ = std::fs::remove_file(&path);
        assert_eq!(file_identity(&path), None);
        project::write_atomic(&path, b"{}").unwrap();
        let first = file_identity(&path);
        assert!(first.is_some());
        assert_eq!(file_identity(&path), first);
        project::write_atomic(&path, b"{}").unwrap();
        assert_ne!(file_identity(&path), first, "same bytes, new file");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
