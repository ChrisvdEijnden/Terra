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

use crate::project::{self, MapFrame, PanoramaInfo, ProjectState, StitchTarget};
use crate::{lock, python, AppState};

pub const SCRIPT_RESOURCE: &str = "python/photo_stitcher.py";
/// The world mosaic aims for this many times the detail of the panorama it goes with.
const WORLD_DETAIL: f64 = 2.0;
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

/// The stitcher's input file.
#[derive(Debug, Serialize)]
struct StitchInput<'a> {
    images: &'a [String],
    /// Metres per panorama pixel to aim for.
    #[serde(skip_serializing_if = "Option::is_none")]
    target_gsd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<ViewRequest>,
    /// The result file of the panorama these photos are lined up with: they are placed
    /// where their twins (the other camera's photos of the same shots) landed in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    align_to: Option<PathBuf>,
}

/// Asks for the mosaic to be saved once more, on the frame of another panorama.
#[derive(Debug, Serialize)]
struct ViewRequest {
    name: &'static str,
    #[serde(flatten)]
    frame: MapFrame,
}

impl<'a> StitchInput<'a> {
    /// The world mosaic takes its detail, its view and the places of its photos from the
    /// panorama it goes with (stored in `dir`); the panorama itself is stitched as the
    /// photos are.
    fn new(
        images: &'a [String],
        target: StitchTarget,
        panorama: Option<&PanoramaInfo>,
        dir: &Path,
    ) -> Self {
        let panorama = panorama.filter(|_| target == StitchTarget::World);
        StitchInput {
            images,
            target_gsd: panorama
                .and_then(PanoramaInfo::metres_per_pixel)
                .map(|metres| metres / WORLD_DETAIL),
            view: panorama
                .and_then(PanoramaInfo::frame)
                .map(|frame| ViewRequest {
                    name: project::WORLD_VIEW_FILE,
                    frame,
                }),
            // a panorama that is not on the map has no places to hand on
            align_to: panorama
                .filter(|panorama| panorama.georeferenced)
                .map(|_| dir.join(StitchTarget::Primary.result_file())),
        }
    }
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
    pub(crate) fn attach(&self, child: Child) -> Arc<Mutex<Child>> {
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

pub(crate) fn wait_shared(child: &Mutex<Child>) -> std::io::Result<ExitStatus> {
    loop {
        if let Some(status) = lock(child).try_wait()? {
            return Ok(status);
        }
        thread::sleep(POLL);
    }
}

/// Reads `pipe` line by line (lossy UTF-8; `\r`-separated progress updates become
/// separate lines) and calls `f` for every non-empty line until EOF.
pub(crate) fn for_each_line<R: Read>(pipe: R, mut f: impl FnMut(&str)) {
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

pub(crate) fn cached_python(state: &AppState, log: &dyn Fn(&str)) -> Result<PathBuf, String> {
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

pub(crate) fn script_path(app: &AppHandle, resource: &str) -> Result<PathBuf, String> {
    let script = app
        .path()
        .resolve(resource, BaseDirectory::Resource)
        .map_err(|e| format!("Could not locate {resource}: {e}"))?;
    if !script.is_file() {
        return Err(format!("{resource} is missing ({})", script.display()));
    }
    Ok(script)
}

/// Runs a whole stitch (blocking). Called on a blocking thread by the command.
pub fn run(app: &AppHandle, run_id: u64, target: StitchTarget) -> Result<ProjectState, String> {
    let state = app.state::<AppState>();
    let guard = state.stitch.try_begin()?;
    *lock(&state.stitch_target) = target;
    if state.export.is_running() {
        return Err("Wait for the export to finish".into());
    }

    let dir = crate::data_dir(app)?;
    let (project, panorama) = {
        let _project = lock(&state.project_lock);
        // Leftovers of a killed run (SIGKILL leaves Python no chance to clean up). Safe:
        // opening and clearing a project are refused while a stitch runs.
        project::cleanup_temp_files(&dir);
        (project::load_project(&dir), project::load_panorama(&dir))
    };
    let images = project.images_for(target);
    if images.len() < 2 {
        return Err(match target {
            StitchTarget::Primary => "Select at least two images to stitch".into(),
            StitchTarget::World => "There are no world photos to stitch".into(),
        });
    }
    // Python writes the result file last and only on success, so a changed result file
    // after the run means this run committed a new panorama.
    let result_file = dir.join(target.result_file());
    let result_before = file_identity(&result_file);
    let input = dir.join(target.input_file());
    let job = StitchInput::new(images, target, panorama.as_ref(), &dir);
    let job = serde_json::to_vec_pretty(&job)
        .map_err(std::io::Error::other)
        .and_then(|json| project::write_atomic(&input, &json));
    job.map_err(|e| format!("Could not write the stitch input: {e}"))?;

    let emit = |line: &str| {
        let _ = app.emit("stitch-log", StitchLog { run_id, line });
    };
    let python = cached_python(&state, &emit)?;
    let script = script_path(app, SCRIPT_RESOURCE)?;
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
        .arg("--panorama-name")
        .arg(target.panorama_file())
        .arg("--result-name")
        .arg(target.result_file())
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
    let committed = file_identity(&result_file) != result_before
        && project::load_mosaic(&dir, target).is_some();
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
    fn world_stitch_takes_detail_and_view_from_the_panorama() {
        let images = vec!["/a_W.JPG".to_string(), "/b_W.JPG".to_string()];
        let panorama = PanoramaInfo {
            path: "/d/panorama.png".into(),
            mtime_ms: 1,
            width: 300,
            height: 200,
            images: Vec::new(),
            included_images: Vec::new(),
            gps_aligned: true,
            estimated_gsd: Some(0.09),
            pano_scale: Some(1.0),
            georeferenced: true,
            aligned: false,
            geotransform: Some([5.3, 1e-6, 0.0, 52.2, 0.0, -1e-6]),
            view: None,
        };
        let json = |target, panorama: Option<&PanoramaInfo>| {
            serde_json::to_value(StitchInput::new(&images, target, panorama, Path::new("/d")))
                .unwrap()
        };

        let world = json(StitchTarget::World, Some(&panorama));
        assert_eq!(world["images"][1], "/b_W.JPG");
        assert_eq!(world["target_gsd"], 0.045);
        assert_eq!(world["view"]["name"], project::WORLD_VIEW_FILE);
        assert_eq!(world["view"]["width"], 300);
        assert_eq!(world["view"]["geotransform"][3], 52.2);
        assert_eq!(world["align_to"], "/d/result.json");

        // The panorama itself, and a world mosaic with nothing to go by, are stitched plainly.
        for plain in [
            json(StitchTarget::Primary, Some(&panorama)),
            json(StitchTarget::World, None),
        ] {
            assert_eq!(plain.as_object().unwrap().len(), 1, "{plain}");
        }
        let no_gps = PanoramaInfo {
            estimated_gsd: None,
            georeferenced: false,
            geotransform: None,
            ..panorama
        };
        assert_eq!(
            json(StitchTarget::World, Some(&no_gps))
                .as_object()
                .unwrap()
                .len(),
            1
        );
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
