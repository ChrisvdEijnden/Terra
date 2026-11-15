//! Tauri commands called from the frontend.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::export::{self, ExportKind, ExportRequest, ExportResult};
use crate::project::{self, Project, ProjectState, StitchTarget};
use crate::projects::{self, RecentProject};
use crate::scan::{self, Flight, FlightSummary, IMAGE_EXTENSIONS};
use crate::{app_dir, data_dir, lock, project_state, stitch, switch_project, AppState};

const BUSY: &str = "Wait for the current stitch to finish";
const EXPORTING: &str = "Wait for the export to finish";

/// The flights found in the folder that was picked last, until one of them is opened.
pub struct PendingFlights {
    id: u64,
    flights: Vec<Flight>,
}

/// What picking a folder led to.
#[derive(Debug, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OpenOutcome {
    Cancelled,
    Opened {
        state: Box<ProjectState>,
    },
    /// The folder holds several flights: open_flight opens the chosen one.
    ChooseFlight {
        scan_id: u64,
        folder: String,
        flights: Vec<FlightSummary>,
    },
}

/// Refuses while a stitch or an export runs (call with the project lock held).
fn ensure_idle(state: &AppState) -> Result<(), String> {
    if state.stitch.is_running() {
        return Err(BUSY.into());
    }
    if state.export.is_running() {
        return Err(EXPORTING.into());
    }
    Ok(())
}

/// Opens `project` as a project of its own; the one that was open is kept for the recent
/// list. A kept project of the same photos is opened again instead, mosaics and all.
/// `name` is the folder the photos came from.
fn open_project(app: &AppHandle, project: &Project, name: Option<&str>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let root = app_dir(app)?;
    let _project = lock(&state.project_lock);
    ensure_idle(&state)?;
    if let Some(id) = projects::find_same_photos(&root, project) {
        switch_project(app, &id)?;
        return Ok(());
    }
    let current = data_dir(app)?;
    // An empty project takes the photos, so a name typed before the first photos were
    // opened belongs to them; otherwise the folder names the project.
    let dir = if project::load_project(&current).images.is_empty() {
        current
    } else {
        projects::project_dir(
            &root,
            &projects::create(&root).map_err(|e| format!("Could not make a new project: {e}"))?,
        )
    };
    let typed_ahead =
        project::load_project(&dir).images.is_empty() && project::load_name(&dir).is_some();
    if !typed_ahead {
        let name = project::sanitize_project_name(name.unwrap_or_default());
        project::save_name(&dir, &name)
            .map_err(|e| format!("Could not set the project name: {e}"))?;
    }
    project::delete_panorama(&dir)
        .map_err(|e| format!("Could not remove the old panorama: {e}"))?;
    project::save_project(&dir, project)
        .map_err(|e| format!("Could not save the image list: {e}"))?;
    let id = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    switch_project(app, &id)?;
    Ok(())
}

fn open_flight_now(app: &AppHandle, flight: Flight) -> Result<ProjectState, String> {
    let name = flight.name.clone();
    open_project(app, &flight.into_project(), Some(&name))?;
    Ok(project_state(app))
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

        let (thermal, world) = scan::sort_photos(picked);
        let project = Project::new(
            project::dedupe_and_sort(thermal),
            project::dedupe_and_sort(world),
        );
        let name = scan::name_for_photos(&project.images);
        open_project(&app, &project, name.as_deref())?;
        Ok(Some(project_state(&app)))
    })
    .await
}

/// Opens the folder dialog and makes a project of the photos in the picked folder,
/// sorted into thermal and world ones.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, window: WebviewWindow) -> Result<OpenOutcome, String> {
    if app.state::<AppState>().stitch.is_running() {
        return Err(BUSY.into());
    }
    blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Select a folder with drone photos")
            .blocking_pick_folder();
        let Some(folder) = picked.and_then(|p| p.into_path().ok()) else {
            return Ok(OpenOutcome::Cancelled);
        };
        let mut flights = scan::scan_folder(&folder)?;
        match flights.len() {
            0 => Err("There are no photos in that folder".into()),
            1 => Ok(OpenOutcome::Opened {
                state: Box::new(open_flight_now(&app, flights.remove(0))?),
            }),
            _ => {
                static NEXT_ID: AtomicU64 = AtomicU64::new(1);
                let scan_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                let summaries = flights.iter().map(FlightSummary::from).collect();
                *lock(&app.state::<AppState>().flights) = Some(PendingFlights {
                    id: scan_id,
                    flights,
                });
                Ok(OpenOutcome::ChooseFlight {
                    scan_id,
                    folder: folder
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    flights: summaries,
                })
            }
        }
    })
    .await
}

/// Opens one of the flights pick_folder found.
#[tauri::command]
pub async fn open_flight(
    app: AppHandle,
    scan_id: u64,
    index: usize,
) -> Result<ProjectState, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let flight = lock(&state.flights)
            .as_ref()
            .filter(|pending| pending.id == scan_id)
            .and_then(|pending| pending.flights.get(index).cloned())
            .ok_or("That list of flights is gone; open the folder again")?;
        let opened = open_flight_now(&app, flight)?;
        *lock(&state.flights) = None;
        Ok(opened)
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
            ensure_idle(&state)?;
            project::save_project(&dir, &Project::default())
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

/// The other projects with photos, most recently opened first.
fn recent_list(app: &AppHandle) -> Result<Vec<RecentProject>, String> {
    let current = data_dir(app)?;
    let current = current
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let mut recent = projects::list(&app_dir(app)?);
    recent.retain(|p| p.id != current);
    Ok(recent)
}

#[tauri::command]
pub async fn recent_projects(app: AppHandle) -> Result<Vec<RecentProject>, String> {
    blocking(move || recent_list(&app)).await
}

/// Deletes a project from the recent list, mosaics and all; returns the list without it.
#[tauri::command]
pub async fn delete_project(app: AppHandle, id: String) -> Result<Vec<RecentProject>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        {
            let _project = lock(&state.project_lock);
            projects::delete(&app_dir(&app)?, &id)
                .map_err(|e| format!("Could not delete that project: {e}"))?;
        }
        recent_list(&app)
    })
    .await
}

/// Opens a project from the recent list.
#[tauri::command]
pub async fn open_recent(app: AppHandle, id: String) -> Result<ProjectState, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        {
            let _project = lock(&state.project_lock);
            ensure_idle(&state)?;
            switch_project(&app, &id)?;
        }
        Ok(project_state(&app))
    })
    .await
}

/// Names of the files an export would replace.
#[tauri::command]
pub async fn export_conflicts(app: AppHandle, kinds: Vec<ExportKind>) -> Result<Vec<String>, String> {
    blocking(move || export::conflicts(&app, &kinds)).await
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

/// Stitches the panorama, or with target "world" the world mosaic that goes with it.
#[tauri::command]
pub async fn stitch_images(
    app: AppHandle,
    run_id: u64,
    target: Option<StitchTarget>,
) -> Result<ProjectState, String> {
    blocking(move || stitch::run(&app, run_id, target.unwrap_or_default())).await
}

#[tauri::command]
pub fn cancel_stitch(app: AppHandle) -> bool {
    app.state::<AppState>().stitch.cancel()
}

/// Raw bytes of an image in the current set, of the current panorama or of the world view.
#[tauri::command]
pub async fn load_image(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        let state = project_state(&app);
        let allowed: Vec<&str> = state
            .images
            .iter()
            .map(String::as_str)
            .chain(state.panorama.as_ref().map(|p| p.path.as_str()))
            .chain(state.world_view.as_ref().map(|v| v.path.as_str()))
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
