//! Saving the results to Documents/Terra/<project name>: the thermal and the world
//! orthomosaic (GeoTIFF), the water polygon (KMZ; these are written by
//! python/terra_export.py) and the area (text).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::project::{self, Kind, PanoramaInfo, Project, StitchTarget};
use crate::stitch::{self, StderrSummary};
use crate::{data_dir, lock, AppState};

const SCRIPT_RESOURCE: &str = "python/terra_export.py";
const ROOT_FOLDER: &str = "Terra";
const DEFAULT_PROJECT: &str = "Untitled";
// "tmp" in the names: project::cleanup_temp_files removes them after a crash.
const MASK_FILE: &str = "export-mask.tmp";
const JOB_FILE: &str = "export-job.tmp";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    /// The orthomosaic of the thermal photos.
    Thermal,
    /// The orthomosaic of the RGB photos.
    World,
    Polygon,
    Area,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub kinds: Vec<ExportKind>,
    /// The name to use while the project has none (the UI's translation of "Untitled").
    pub fallback_name: String,
    pub area_hectares: Option<f64>,
    /// The panorama the mask and the area were measured on.
    pub panorama_mtime_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// For display, relative to the home folder.
    pub folder: String,
    pub files: Vec<String>,
}

pub fn file_name(kind: ExportKind, project: &str) -> String {
    match kind {
        ExportKind::Thermal => format!("orthomosaic_{project}_T.tif"),
        ExportKind::World => format!("orthomosaic_{project}_W.tif"),
        ExportKind::Polygon => format!("polygon_{project}.kmz"),
        ExportKind::Area => format!("hectare_{project}.txt"),
    }
}

pub fn area_text(project: &str, hectares: f64) -> String {
    format!("Plas-dras {project}: {hectares:.3} Hectare")
}

fn checked_area(area: Option<f64>) -> Result<f64, String> {
    area.filter(|a| a.is_finite() && *a >= 0.0)
        .ok_or_else(|| "There is no area to save yet".to_string())
}

fn project_name(dir: &Path, fallback: &str) -> String {
    project::load_name(dir).unwrap_or_else(|| {
        let name = project::sanitize_project_name(fallback);
        if name.is_empty() {
            DEFAULT_PROJECT.to_string()
        } else {
            name
        }
    })
}

fn project_folder(app: &AppHandle, project: &str) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("Could not find the Documents folder: {e}"))?;
    Ok(documents.join(ROOT_FOLDER).join(project))
}

pub fn conflicts(
    app: &AppHandle,
    kinds: &[ExportKind],
    fallback: &str,
) -> Result<Vec<String>, String> {
    let project = project_name(&data_dir(app)?, fallback);
    let folder = project_folder(app, &project)?;
    Ok(kinds
        .iter()
        .map(|kind| file_name(*kind, &project))
        .filter(|name| folder.join(name).exists())
        .collect())
}

pub fn stage_mask(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    fs::write(data_dir(app)?.join(MASK_FILE), bytes)
        .map_err(|e| format!("Could not store the water mask: {e}"))
}

/// The panorama the frontend measured on, refusing anything that changed since.
fn current_panorama(dir: &Path, mtime_ms: Option<u64>) -> Result<PanoramaInfo, String> {
    let panorama =
        project::load_panorama(dir).ok_or_else(|| "There is no panorama to save".to_string())?;
    if mtime_ms != Some(panorama.mtime_ms) {
        return Err("The panorama changed; try again".into());
    }
    Ok(panorama)
}

/// Which mosaic an orthomosaic is made from. The panorama is the thermal one when there
/// are thermal photos and the RGB one otherwise; RGB photos that go with thermal ones
/// have a mosaic of their own.
fn orthomosaic_source(kind: ExportKind, photos: Kind) -> Result<StitchTarget, String> {
    match (kind, photos) {
        (ExportKind::Thermal, Kind::Thermal) | (ExportKind::World, Kind::World) => {
            Ok(StitchTarget::Primary)
        }
        (ExportKind::World, Kind::Thermal) => Ok(StitchTarget::World),
        (ExportKind::Thermal, Kind::World) => Err("This project has no thermal photos".into()),
        (ExportKind::Polygon | ExportKind::Area, _) => Err("That is not an orthomosaic".into()),
    }
}

/// The world mosaic, refusing one that was stitched from other photos.
fn current_world_mosaic(dir: &Path, project: &Project) -> Result<PanoramaInfo, String> {
    project::load_mosaic(dir, StitchTarget::World)
        .filter(|world| project::same_set(&world.images, &project.world_images))
        .ok_or_else(|| "The world orthomosaic is not stitched yet".to_string())
}

fn map_coordinates(mosaic: &PanoramaInfo) -> Result<project::GeoTransform, String> {
    mosaic
        .geotransform
        .ok_or_else(|| "This panorama has no map coordinates".to_string())
}

/// Runs terra_export.py on `job` and waits for it.
fn run_script(app: &AppHandle, dir: &Path, job: &Path) -> Result<(), String> {
    let state = app.state::<AppState>();
    let python = stitch::cached_python(&state, &|_| {})?;
    let script = stitch::script_path(app, SCRIPT_RESOURCE)?;
    let spawned = Command::new(&python)
        .arg("-u")
        .arg(&script)
        .arg("--job")
        .arg(job)
        .current_dir(dir)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
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
    let stderr = child.stderr.take();
    let child = state.export.attach(child);
    let err_thread = stderr.map(|pipe| {
        thread::spawn(move || {
            let mut summary = StderrSummary::default();
            stitch::for_each_line(pipe, |line| summary.push(line));
            summary
        })
    });
    let status = stitch::wait_shared(&child);
    let summary = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let status = status.map_err(|e| format!("Lost track of the export: {e}"))?;
    if status.success() {
        return Ok(());
    }
    let desc = stitch::describe_status(&status);
    eprintln!("[export] failed ({desc}); stderr tail:");
    for line in summary.tail() {
        eprintln!("[export]   {line}");
    }
    Err(if summary.tail().next().is_some() {
        summary.failure_message(&desc)
    } else {
        format!("The export stopped unexpectedly ({desc})")
    })
}

fn export(app: &AppHandle, dir: &Path, request: &ExportRequest) -> Result<ExportResult, String> {
    if request.kinds.is_empty() {
        return Err("Nothing to save".into());
    }
    let wants = |kind| request.kinds.contains(&kind);
    let project = project_name(dir, &request.fallback_name);
    let folder = project_folder(app, &project)?;
    let path_of = |kind| folder.join(file_name(kind, &project));
    let photos = project::load_project(dir);

    // Everything that can be refused is checked before anything is written.
    let area = wants(ExportKind::Area)
        .then(|| checked_area(request.area_hectares))
        .transpose()?;
    let mut panorama = None; // loaded once, and only when something is made from it
    let mut measured_on = || match &panorama {
        Some(loaded) => Ok::<PanoramaInfo, String>(PanoramaInfo::clone(loaded)),
        None => {
            let loaded = current_panorama(dir, request.panorama_mtime_ms)?;
            panorama = Some(loaded.clone());
            Ok(loaded)
        }
    };
    let mut orthomosaics = Vec::new();
    for kind in [ExportKind::Thermal, ExportKind::World] {
        if !wants(kind) {
            continue;
        }
        let mosaic = match orthomosaic_source(kind, photos.kind)? {
            StitchTarget::Primary => measured_on()?,
            StitchTarget::World => current_world_mosaic(dir, &photos)?,
        };
        orthomosaics.push(json!({
            "panorama": mosaic.path,
            "geotransform": map_coordinates(&mosaic)?,
            "output": path_of(kind),
        }));
    }
    let polygon = if wants(ExportKind::Polygon) {
        let measured = measured_on()?;
        Some(json!({
            "mask": dir.join(MASK_FILE),
            "width": measured.width,
            "height": measured.height,
            "geotransform": map_coordinates(&measured)?,
            "output": path_of(ExportKind::Polygon),
        }))
    } else {
        None
    };

    fs::create_dir_all(&folder).map_err(|e| format!("the folder could not be created ({e})"))?;

    if !orthomosaics.is_empty() || polygon.is_some() {
        let job_path = dir.join(JOB_FILE);
        let job = json!({ "name": project, "orthomosaics": orthomosaics, "polygon": polygon });
        project::write_atomic(&job_path, job.to_string().as_bytes())
            .map_err(|e| format!("Could not write the export job: {e}"))?;
        run_script(app, dir, &job_path)?;
    }
    if let Some(area) = area {
        project::write_atomic(
            &path_of(ExportKind::Area),
            area_text(&project, area).as_bytes(),
        )
        .map_err(|e| format!("the area could not be written ({e})"))?;
    }

    Ok(ExportResult {
        folder: format!("Documents/{ROOT_FOLDER}/{project}"),
        files: request
            .kinds
            .iter()
            .map(|kind| file_name(*kind, &project))
            .collect(),
    })
}

/// Runs a whole export (blocking). Called on a blocking thread by the command.
pub fn run(app: &AppHandle, request: &ExportRequest) -> Result<ExportResult, String> {
    let state = app.state::<AppState>();
    let _guard = state
        .export
        .try_begin()
        .map_err(|_| "An export is already running".to_string())?;
    if state.stitch.is_running() {
        return Err("Wait for the current stitch to finish".into());
    }
    let dir = data_dir(app)?;
    let result = export(app, &dir, request);
    // Whatever happened, the staged inputs are not needed any more.
    let _ = fs::remove_file(dir.join(MASK_FILE));
    let _ = fs::remove_file(dir.join(JOB_FILE));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_follow_the_project_name() {
        assert_eq!(
            file_name(ExportKind::Thermal, "Polder"),
            "orthomosaic_Polder_T.tif"
        );
        assert_eq!(
            file_name(ExportKind::World, "Polder"),
            "orthomosaic_Polder_W.tif"
        );
        assert_eq!(
            file_name(ExportKind::Polygon, "Polder"),
            "polygon_Polder.kmz"
        );
        assert_eq!(file_name(ExportKind::Area, "Polder"), "hectare_Polder.txt");
    }

    #[test]
    fn orthomosaics_come_from_the_right_mosaic() {
        use ExportKind::{Polygon, Thermal, World};
        assert_eq!(
            orthomosaic_source(Thermal, Kind::Thermal),
            Ok(StitchTarget::Primary)
        );
        assert_eq!(
            orthomosaic_source(World, Kind::Thermal),
            Ok(StitchTarget::World)
        );
        // RGB photos only: they are the panorama, and it is saved as the world one.
        assert_eq!(
            orthomosaic_source(World, Kind::World),
            Ok(StitchTarget::Primary)
        );
        assert!(orthomosaic_source(Thermal, Kind::World).is_err());
        assert!(orthomosaic_source(Polygon, Kind::Thermal).is_err());
    }

    #[test]
    fn area_text_format() {
        assert_eq!(
            area_text("Polder", 1.2344),
            "Plas-dras Polder: 1.234 Hectare"
        );
        assert_eq!(
            area_text("Polder", 12.0),
            "Plas-dras Polder: 12.000 Hectare"
        );
        assert_eq!(area_text("Polder", 0.0), "Plas-dras Polder: 0.000 Hectare");
    }

    #[test]
    fn area_must_be_a_real_number() {
        assert_eq!(checked_area(Some(1.5)), Ok(1.5));
        assert_eq!(checked_area(Some(0.0)), Ok(0.0));
        assert!(checked_area(None).is_err());
        assert!(checked_area(Some(f64::NAN)).is_err());
        assert!(checked_area(Some(-1.0)).is_err());
    }

    #[test]
    fn stored_name_wins_over_the_fallback() {
        let dir = std::env::temp_dir().join(format!("terra-export-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let _ = fs::remove_file(dir.join(project::PROJECT_NAME_FILE));
        assert_eq!(project_name(&dir, "Naamloos"), "Naamloos");
        assert_eq!(project_name(&dir, " ../ "), "-");
        assert_eq!(project_name(&dir, "..."), DEFAULT_PROJECT);
        project::save_name(&dir, "Polder").unwrap();
        assert_eq!(project_name(&dir, "Naamloos"), "Polder");
        fs::remove_dir_all(&dir).unwrap();
    }
}
