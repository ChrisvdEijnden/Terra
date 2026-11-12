mod commands;
mod export;
mod project;
mod python;
mod scan;
mod stitch;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use project::{Project, ProjectState, StitchTarget};

/// App-wide state.
#[derive(Default)]
pub struct AppState {
    /// Serializes read-modify-write of project.json.
    project_lock: Mutex<()>,
    /// The single stitch run (child process handle, cancel flag).
    stitch: stitch::StitchState,
    /// Which mosaic that run makes (meaningful while it runs).
    stitch_target: Mutex<StitchTarget>,
    /// Flights of the folder that was picked last, while the user chooses one.
    flights: Mutex<Option<commands::PendingFlights>>,
    /// The single export run (same one-child-at-a-time bookkeeping as the stitch).
    export: stitch::StitchState,
    /// First interpreter that passed the import probe (successes only).
    python: Mutex<Option<PathBuf>>,
}

/// Locks a mutex, ignoring poisoning (state stays usable after a panicked thread).
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The app data dir (created on demand), e.g.
/// ~/Library/Application Support/com.chrisvandeneijnden.terra-app on macOS.
pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the app data folder: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub(crate) fn project_state(app: &AppHandle) -> ProjectState {
    let state = app.state::<AppState>();
    let stitching = state
        .stitch
        .is_running()
        .then(|| *lock(&state.stitch_target));
    let dir = data_dir(app).map_err(|e| eprintln!("[terra] {e}")).ok();
    let dir = dir.as_deref();
    let project = dir.map(project::load_project).unwrap_or_default();
    let panorama = dir.and_then(project::load_panorama);
    let world_panorama = dir.and_then(|dir| project::load_mosaic(dir, StitchTarget::World));
    let world_view = project::world_view(
        panorama.as_ref(),
        world_panorama.as_ref(),
        &project.world_images,
    );
    let Project {
        images,
        kind,
        world_images,
    } = project;
    ProjectState {
        name: dir.and_then(project::load_name),
        images,
        kind,
        world_images,
        panorama,
        world_panorama,
        world_view,
        stitching,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // Temp files left by a stitch that was killed when the app last quit.
            if let Ok(dir) = data_dir(app.handle()) {
                project::cleanup_temp_files(&dir);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must not leave Python running.
            if let WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.stitch.kill_running();
                state.export.kill_running();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_project,
            commands::pick_images,
            commands::pick_folder,
            commands::open_flight,
            commands::clear_project,
            commands::stitch_images,
            commands::cancel_stitch,
            commands::load_image,
            commands::set_project_name,
            commands::export_conflicts,
            commands::stage_export_mask,
            commands::export_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let state = app.state::<AppState>();
            state.stitch.kill_running();
            state.export.kill_running();
        }
    });
}
