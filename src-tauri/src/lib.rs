mod commands;
mod project;
mod python;
mod stitch;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use project::ProjectState;

/// App-wide state.
#[derive(Default)]
pub struct AppState {
    /// Serializes read-modify-write of project.json.
    project_lock: Mutex<()>,
    /// The single stitch run (child process handle, cancel flag).
    stitch: stitch::StitchState,
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
    let stitching = app.state::<AppState>().stitch.is_running();
    match data_dir(app) {
        Ok(dir) => ProjectState {
            images: project::load_images(&dir),
            panorama: project::load_panorama(&dir),
            stitching,
        },
        Err(e) => {
            eprintln!("[terra] {e}");
            ProjectState {
                images: Vec::new(),
                panorama: None,
                stitching,
            }
        }
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
                window.state::<AppState>().stitch.kill_running();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_project,
            commands::pick_images,
            commands::clear_project,
            commands::stitch_images,
            commands::cancel_stitch,
            commands::load_image,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<AppState>().stitch.kill_running();
        }
    });
}
