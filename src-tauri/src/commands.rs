//! Tauri commands called from the frontend.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::export::{self, ExportKind, ExportRequest, ExportResult};
use crate::project::{self, ProjectState};
use crate::{data_dir, lock, project_state, stitch, AppState};

const BUSY: &str = "Wait for the current stitch to finish";
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "tif", "tiff"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickMode {
    Replace,
    Add,
}

/// Runs `f` on a blocking thread so the main (UI) thread never waits on I/O.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

#[tauri::command]
pub async fn get_project(app: AppHandle) -> Result<ProjectState, String> {
    blocking(move || Ok(project_state(&app))).await
}

#[tauri::command]
pub async fn pick_images(
    app: AppHandle,
    window: WebviewWindow,
    mode: PickMode,
) -> Result<Option<ProjectState>, String> {
    if app.state::<AppState>().stitch.is_running() {
        return Err(BUSY.into());
    }
    blocking(move || {
        // blocking_pick_files must not run on the main thread; this is a worker thread.
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Select drone photos")
            .add_filter("Images", IMAGE_EXTENSIONS)
            .blocking_pick_files();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let picked: Vec<PathBuf> = picked
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect();
        if picked.is_empty() {
            return Ok(None);
        }

        let state = app.state::<AppState>();
        let dir = data_dir(&app)?;
        {
            let _project = lock(&state.project_lock);
            if state.stitch.is_running() {
                return Err(BUSY.into());
            }
            let images = match mode {
                PickMode::Replace => {
                    // New photos are a new project, but a name typed before the first
                    // photos were opened belongs to them.
                    if !project::load_images(&dir).is_empty() {
                        project::save_name(&dir, "")
                            .map_err(|e| format!("Could not reset the project name: {e}"))?;
                    }
                    project::delete_panorama(&dir)
                        .map_err(|e| format!("Could not remove the old panorama: {e}"))?;
                    project::dedupe_and_sort(picked)
                }
                PickMode::Add => project::dedupe_and_sort(
                    project::load_images(&dir)
                        .into_iter()
                        .map(PathBuf::from)
                        .chain(picked),
                ),
            };
            project::save_images(&dir, &images)
                .map_err(|e| format!("Could not save the image list: {e}"))?;
        }
        Ok(Some(project_state(&app)))
    })
    .await
}

#[tauri::command]
pub async fn clear_project(app: AppHandle) -> Result<ProjectState, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let dir = data_dir(&app)?;
        {
            let _project = lock(&state.project_lock);
            if state.stitch.is_running() {
                return Err(BUSY.into());
            }
            project::save_images(&dir, &[])
                .map_err(|e| format!("Could not save the image list: {e}"))?;
            project::delete_panorama(&dir)
                .map_err(|e| format!("Could not remove the panorama: {e}"))?;
            project::save_name(&dir, "")
                .map_err(|e| format!("Could not reset the project name: {e}"))?;
        }
        Ok(project_state(&app))
    })
    .await
}

/// Saves the project name; the returned state holds it as it will be used in file names.
#[tauri::command]
pub async fn set_project_name(app: AppHandle, name: String) -> Result<ProjectState, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let dir = data_dir(&app)?;
        {
            let _project = lock(&state.project_lock);
            project::save_name(&dir, &project::sanitize_project_name(&name))
                .map_err(|e| format!("Could not save the project name: {e}"))?;
        }
        Ok(project_state(&app))
    })
    .await
}

/// Names of the files an export would replace.
#[tauri::command]
pub async fn export_conflicts(
    app: AppHandle,
    kinds: Vec<ExportKind>,
    fallback_name: String,
) -> Result<Vec<String>, String> {
    blocking(move || export::conflicts(&app, &kinds, &fallback_name)).await
}

/// Takes the water mask (one byte per panorama pixel) ahead of export_files, as raw
/// bytes so it does not have to go through JSON.
#[tauri::command]
pub async fn stage_export_mask(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // Tauri's postMessage IPC fallback delivers raw bytes as a JSON number array.
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|e| format!("Unexpected water mask data: {e}"))?,
    };
    blocking(move || export::stage_mask(&app, &bytes)).await
}

#[tauri::command]
pub async fn export_files(app: AppHandle, request: ExportRequest) -> Result<ExportResult, String> {
    blocking(move || export::run(&app, &request)).await
}

#[tauri::command]
pub async fn stitch_images(app: AppHandle, run_id: u64) -> Result<ProjectState, String> {
    blocking(move || stitch::run(&app, run_id)).await
}

#[tauri::command]
pub fn cancel_stitch(app: AppHandle) -> bool {
    app.state::<AppState>().stitch.cancel()
}

/// Raw bytes of an image in the current set or of the current panorama.
#[tauri::command]
pub async fn load_image(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        let dir = data_dir(&app)?;
        let images = project::load_images(&dir);
        let panorama = project::load_panorama(&dir);
        let allowed: Vec<&str> = images
            .iter()
            .map(String::as_str)
            .chain(panorama.as_ref().map(|p| p.path.as_str()))
            .collect();
        let file = project::allowed_path(Path::new(&path), allowed.iter().copied())
            .ok_or_else(|| not_allowed_reason(&path, &allowed))?;
        let bytes = std::fs::read(&file).map_err(|e| format!("Could not read {path}: {e}"))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

/// Why `path` cannot be loaded. Only an exact entry of the project that no longer exists
/// is reported as missing; every other path is just "Not allowed", so existence is never
/// revealed for arbitrary paths.
fn not_allowed_reason(path: &str, allowed: &[&str]) -> String {
    if allowed.contains(&path) && !Path::new(path).exists() {
        format!("The file is missing or was moved: {path}")
    } else {
        "Not allowed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_project_file_is_reported_as_missing() {
        let gone = "/nonexistent/terra/DJI_0133_T.JPG";
        assert_eq!(
            not_allowed_reason(gone, &[gone]),
            format!("The file is missing or was moved: {gone}")
        );
        // Not in the project: never says whether it exists.
        assert_eq!(not_allowed_reason(gone, &[]), "Not allowed");
        assert_eq!(not_allowed_reason("/etc/hosts", &[]), "Not allowed");
        // In the project and present but rejected anyway (e.g. a non-canonical alias).
        assert_eq!(not_allowed_reason("/", &["/"]), "Not allowed");
    }
}
