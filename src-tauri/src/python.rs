//! Finding a Python interpreter that can run photo_stitcher.py.
//!
//! Order: TERRA_PYTHON, the project .venv (debug builds only), the python.org framework
//! install, Homebrew (Apple silicon and Intel), `python3` on PATH, /usr/bin/python3.
//! /usr/bin/python3 is a stub that pops up the "install Command Line Tools" dialog when
//! the tools are missing, so it is only tried when Xcode or the CLT are installed.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::stitch::{wait_with_timeout, CANCELLED};

// The script's hard imports; Pillow is optional there (faster image-size reads).
const PROBE: &str = "import stitching, cv2, numpy";
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const SYSTEM_PYTHON: &str = "/usr/bin/python3";

/// Candidate interpreters in priority order (not yet checked).
pub fn candidates() -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("TERRA_PYTHON").filter(|p| !p.is_empty()) {
        c.push(PathBuf::from(p));
    }
    #[cfg(debug_assertions)]
    c.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".venv")
            .join("bin")
            .join("python3"),
    );
    for p in [
        "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ] {
        c.push(PathBuf::from(p));
    }
    if let Some(p) = search_path("python3") {
        c.push(p);
    }
    c.push(PathBuf::from(SYSTEM_PYTHON));
    c
}

fn search_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// True when /usr/bin/python3 is backed by Xcode or the Command Line Tools, i.e. running
/// it will not trigger the macOS "install developer tools" popup.
fn developer_tools_installed() -> bool {
    if Path::new("/Library/Developer/CommandLineTools/usr/bin/python3").exists() {
        return true;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = std::env::var_os("DEVELOPER_DIR") {
        dirs.push(PathBuf::from(d));
    }
    // The selected developer dir (what `xcode-select -p` prints) is this symlink.
    if let Ok(d) = std::fs::read_link("/var/db/xcode_select_link") {
        dirs.push(d);
    }
    dirs.push(PathBuf::from("/Applications/Xcode.app/Contents/Developer"));
    dirs.iter().any(|d| d.join("usr/bin/python3").exists())
}

/// True if running `python` would end up at the /usr/bin/python3 stub.
fn is_system_stub(python: &Path) -> bool {
    std::fs::canonicalize(python)
        .map(|p| p == Path::new(SYSTEM_PYTHON))
        .unwrap_or(false)
}

/// True if `python` can import the dependencies. Gives up (false) when `cancelled`.
fn probe(python: &Path, cancelled: &dyn Fn() -> bool) -> bool {
    let child = Command::new(python)
        .args(["-c", PROBE])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(mut child) => matches!(
            wait_with_timeout(&mut child, PROBE_TIMEOUT, cancelled),
            Some(status) if status.success()
        ),
        Err(_) => false,
    }
}

/// Probes the candidates and returns the first that can import the dependencies.
/// Stops with the "Stitching cancelled" error as soon as `cancelled` returns true.
pub fn find_python(cancelled: &dyn Fn() -> bool) -> Result<PathBuf, String> {
    let dev_tools = developer_tools_installed();
    let mut tried: Vec<PathBuf> = Vec::new();
    for cand in candidates() {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        // Dedupe by the path as given, not the canonical one: a venv's python3 is a
        // symlink to the base interpreter but has its own site-packages.
        if tried.contains(&cand) || !is_executable(&cand) {
            continue;
        }
        if is_system_stub(&cand) && !dev_tools {
            continue;
        }
        tried.push(cand.clone());
        if probe(&cand, cancelled) {
            return Ok(cand);
        }
    }
    if cancelled() {
        return Err(CANCELLED.into());
    }
    let tried = if tried.is_empty() {
        "none found".to_string()
    } else {
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Err(format!(
        "No Python 3 with the stitching packages was found (tried: {tried}). \
         Install them with: python3 -m pip install \"stitching>=0.7,<0.8\" numpy Pillow \
         (or -r src-tauri/python/requirements.txt in a checkout), or set TERRA_PYTHON \
         to the Python to use."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_order() {
        let c = candidates();
        assert_eq!(c.last().unwrap(), Path::new(SYSTEM_PYTHON));
        let fw = c
            .iter()
            .position(|p| p.starts_with("/Library/Frameworks"))
            .unwrap();
        let brew = c
            .iter()
            .position(|p| p == Path::new("/opt/homebrew/bin/python3"))
            .unwrap();
        assert!(fw < brew);
        #[cfg(debug_assertions)]
        assert!(
            c.iter()
                .position(|p| p.ends_with(".venv/bin/python3"))
                .unwrap()
                < fw
        );
    }

    #[test]
    fn missing_interpreter_fails_probe() {
        assert!(!probe(Path::new("/nonexistent/python3"), &|| false));
        assert!(!is_system_stub(Path::new("/nonexistent/python3")));
    }

    #[test]
    fn cancel_stops_search() {
        assert_eq!(find_python(&|| true), Err(CANCELLED.to_string()));
    }

    /// Environment-dependent; run with `cargo test --offline -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn finds_python_on_this_machine() {
        let r = find_python(&|| false);
        eprintln!("find_python: {r:?}");
        assert!(r.is_ok());
    }
}
