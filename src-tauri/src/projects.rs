//! Several projects side by side, so a recent one can be opened again without stitching it
//! again.
//!
//! Layout (in `app_data_dir`):
//! - `projects/<id>/`         one folder per project, holding the files `project.rs`
//!   describes (photo list, name, mosaics), plus `opened_at.txt`
//! - `current_project.txt`    the id of the project that is open
//!
//! Older versions kept the single project's files in `app_data_dir` itself; they are moved
//! into a project folder of their own the first time.
//!
//! Everything here is plain std code so it can be unit tested without a Tauri app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::project::{self, Kind, Project};

pub const PROJECTS_DIR: &str = "projects";
pub const CURRENT_FILE: &str = "current_project.txt";
/// When the project was last opened, in ms since the epoch.
pub const OPENED_FILE: &str = "opened_at.txt";

/// The project files older versions kept in the app data folder itself.
const LEGACY_FILES: [&str; 9] = [
    project::PROJECT_FILE,
    project::PROJECT_NAME_FILE,
    project::STITCH_INPUT_FILE,
    project::PANORAMA_FILE,
    project::RESULT_FILE,
    project::WORLD_INPUT_FILE,
    project::WORLD_PANORAMA_FILE,
    project::WORLD_RESULT_FILE,
    project::WORLD_VIEW_FILE,
];

/// A project in the recent list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: Option<String>,
    pub kind: Kind,
    /// Number of photos that are measured on.
    pub images: usize,
    pub has_panorama: bool,
    pub opened_at_ms: u64,
}

/// Ids are made here; anything else (a path, "..") is refused.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn project_dir(root: &Path, id: &str) -> PathBuf {
    root.join(PROJECTS_DIR).join(id)
}

/// The open project's id, if it names an existing project folder.
pub fn current_id(root: &Path) -> Option<String> {
    let id = fs::read_to_string(root.join(CURRENT_FILE)).ok()?;
    let id = id.trim();
    (valid_id(id) && project_dir(root, id).is_dir()).then(|| id.to_string())
}

/// Makes `id` the open project and records when it was opened.
pub fn set_current(root: &Path, id: &str) -> io::Result<PathBuf> {
    if !valid_id(id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bad project id",
        ));
    }
    let dir = project_dir(root, id);
    if !dir.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "that project is gone",
        ));
    }
    project::write_atomic(&dir.join(OPENED_FILE), now_ms().to_string().as_bytes())?;
    project::write_atomic(&root.join(CURRENT_FILE), id.as_bytes())?;
    Ok(dir)
}

/// Makes an empty project folder and returns its id (not opened yet).
pub fn create(root: &Path) -> io::Result<String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    loop {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let id = format!("{}-{n}", now_ms());
        let dir = project_dir(root, &id);
        fs::create_dir_all(dir.parent().expect("project dirs have a parent"))?;
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(id),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

/// The open project's folder: the recorded one, else the files of an older version moved
/// into a project of their own, else a new empty project.
pub fn ensure_current(root: &Path) -> io::Result<PathBuf> {
    if let Some(id) = current_id(root) {
        return Ok(project_dir(root, &id));
    }
    let id = match migrate_legacy(root)? {
        Some(id) => id,
        None => create(root)?,
    };
    set_current(root, &id)
}

/// Moves the single project of an older version into a project folder. None when there
/// was nothing to move.
pub fn migrate_legacy(root: &Path) -> io::Result<Option<String>> {
    let present: Vec<&str> = LEGACY_FILES
        .iter()
        .copied()
        .filter(|name| root.join(name).is_file())
        .collect();
    if present.is_empty() {
        return Ok(None);
    }
    let id = create(root)?;
    let dir = project_dir(root, &id);
    for name in present {
        fs::rename(root.join(name), dir.join(name))?;
    }
    // The result files point at their mosaics by full path.
    for result in [project::RESULT_FILE, project::WORLD_RESULT_FILE] {
        rebase_result(&dir.join(result), root, &dir);
    }
    Ok(Some(id))
}

/// Points the paths in a moved result file at the files next to it.
fn rebase_result(path: &Path, from: &Path, to: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let rebase = |value: &mut serde_json::Value| {
        let Some(old) = value.as_str().map(PathBuf::from) else {
            return;
        };
        if let (Some(parent), Some(name)) = (old.parent(), old.file_name()) {
            if parent == from {
                *value = serde_json::Value::String(to.join(name).to_string_lossy().into_owned());
            }
        }
    };
    if let Some(v) = json.get_mut("panorama") {
        rebase(v);
    }
    if let Some(v) = json.get_mut("view").and_then(|view| view.get_mut("path")) {
        rebase(v);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&json) {
        if let Err(e) = project::write_atomic(path, &bytes) {
            eprintln!("[terra] could not update {}: {e}", path.display());
        }
    }
}

fn opened_at(dir: &Path) -> u64 {
    fs::read_to_string(dir.join(OPENED_FILE))
        .ok()
        .and_then(|t| t.trim().parse().ok())
        .unwrap_or(0)
}

/// Every project with photos, most recently opened first.
pub fn list(root: &Path) -> Vec<RecentProject> {
    let Ok(entries) = fs::read_dir(root.join(PROJECTS_DIR)) else {
        return Vec::new();
    };
    let mut recent: Vec<RecentProject> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let id = e.file_name().into_string().ok().filter(|id| valid_id(id))?;
            let dir = e.path();
            let project = project::load_project(&dir);
            if project.images.is_empty() {
                return None;
            }
            Some(RecentProject {
                name: project::load_name(&dir),
                kind: project.kind,
                images: project.images.len(),
                has_panorama: project::load_panorama(&dir).is_some(),
                opened_at_ms: opened_at(&dir),
                id,
            })
        })
        .collect();
    recent.sort_by(|a, b| {
        b.opened_at_ms
            .cmp(&a.opened_at_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    recent
}

/// A kept project made of exactly these photos.
pub fn find_same_photos(root: &Path, photos: &Project) -> Option<String> {
    let entries = fs::read_dir(root.join(PROJECTS_DIR)).ok()?;
    entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok().filter(|id| valid_id(id)))
        .find(|id| {
            let kept = project::load_project(&project_dir(root, id));
            !kept.images.is_empty()
                && project::same_set(&kept.images, &photos.images)
                && project::same_set(&kept.world_images, &photos.world_images)
        })
}

/// Removes a project folder that has no photos (nothing to come back to).
pub fn remove_if_empty(dir: &Path) {
    if project::load_project(dir).images.is_empty() {
        if let Err(e) = fs::remove_dir_all(dir) {
            eprintln!("[terra] could not remove {}: {e}", dir.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "terra-projects-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    fn photos(names: &[&str]) -> Project {
        Project::new(
            names.iter().map(|n| format!("/f/{n}_T.JPG")).collect(),
            Vec::new(),
        )
    }

    #[test]
    fn ids_cannot_leave_the_projects_folder() {
        assert!(valid_id("1731600000000-0"));
        for bad in ["", "..", "a/b", "a\\b", ".hidden", "a b"] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(!valid_id(&"1".repeat(41)));
    }

    #[test]
    fn a_fresh_install_gets_an_empty_project() {
        let root = temp_root("fresh");
        let dir = ensure_current(&root).unwrap();
        assert!(dir.is_dir());
        assert_eq!(ensure_current(&root).unwrap(), dir, "stays the same");
        assert!(list(&root).is_empty(), "empty projects are not listed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_old_single_project_is_moved_into_a_folder() {
        let root = temp_root("legacy");
        project::save_project(&root, &photos(&["a", "b"])).unwrap();
        project::save_name(&root, "Polder").unwrap();
        fs::write(root.join(project::PANORAMA_FILE), b"png").unwrap();
        let old_pano = root.join(project::PANORAMA_FILE);
        fs::write(
            root.join(project::RESULT_FILE),
            format!(
                r#"{{"panorama": {:?}, "width": 1, "height": 1}}"#,
                old_pano.to_str().unwrap()
            ),
        )
        .unwrap();

        let dir = ensure_current(&root).unwrap();
        assert!(!root.join(project::PROJECT_FILE).exists());
        assert_eq!(project::load_name(&dir).as_deref(), Some("Polder"));
        assert_eq!(project::load_project(&dir).images.len(), 2);
        let result = fs::read_to_string(dir.join(project::RESULT_FILE)).unwrap();
        let result = project::parse_result(&result).unwrap();
        assert_eq!(
            result.panorama,
            dir.join(project::PANORAMA_FILE).to_str().unwrap()
        );
        assert!(project::load_panorama(&dir).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recent_projects_are_listed_newest_first() {
        let root = temp_root("recent");
        let first = create(&root).unwrap();
        project::save_project(&project_dir(&root, &first), &photos(&["a", "b"])).unwrap();
        set_current(&root, &first).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = create(&root).unwrap();
        project::save_project(&project_dir(&root, &second), &photos(&["c"])).unwrap();
        project::save_name(&project_dir(&root, &second), "Plas").unwrap();
        set_current(&root, &second).unwrap();
        let empty = create(&root).unwrap();

        let recent = list(&root);
        let ids: Vec<&str> = recent.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, [second.as_str(), first.as_str()]);
        assert_eq!(recent[0].name.as_deref(), Some("Plas"));
        assert_eq!((recent[1].images, recent[1].has_panorama), (2, false));
        assert_eq!(current_id(&root).as_deref(), Some(second.as_str()));

        assert_eq!(
            find_same_photos(&root, &photos(&["b", "a"])),
            Some(first.clone())
        );
        assert_eq!(find_same_photos(&root, &photos(&["a"])), None);

        remove_if_empty(&project_dir(&root, &first));
        assert!(project_dir(&root, &first).is_dir(), "has photos");
        remove_if_empty(&project_dir(&root, &empty));
        assert!(!project_dir(&root, &empty).exists());
        assert!(set_current(&root, &empty).is_err(), "gone");
        assert!(set_current(&root, "../x").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
