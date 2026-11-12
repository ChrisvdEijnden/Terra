//! Telling thermal photos from RGB ones, and finding the flights in a folder.
//!
//! A DJI thermal drone saves every shot once per camera: `DJI_..._T.JPG` (thermal),
//! `_W`/`_V` (wide, visible light) and `_Z` (zoom), either mixed in one folder or in a
//! folder per camera. Everything here is plain std code so it can be unit tested.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::project::{self, Project};

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "tif", "tiff"];
/// How many folders deep a picked folder is searched.
const MAX_DEPTH: usize = 4;
/// A folder with more photos than this is not a survey (the wrong folder was picked).
const MAX_PHOTOS: usize = 20_000;
/// DJI writes its XMP block near the start of the file.
const XMP_PROBE_BYTES: u64 = 128 * 1024;
/// Folders named after a camera hold one camera's photos of the flight above them.
const CAMERA_FOLDERS: &[&str] = &[
    "t", "w", "v", "thermal", "infrared", "ir", "wide", "world", "visible", "rgb",
];

/// The camera a photo came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Camera {
    Thermal,
    World,
    /// Zoom and other cameras: these do not cover the ground like the other two.
    Other,
}

/// From the name alone, for DJI's own file names. None when the name does not say.
pub fn camera_from_name(path: &Path) -> Option<Camera> {
    let stem = path.file_stem()?.to_str()?.to_ascii_uppercase();
    if !stem.starts_with("DJI_") {
        return None;
    }
    match stem.rsplit('_').next()? {
        "T" => Some(Camera::Thermal),
        "W" | "V" => Some(Camera::World),
        "Z" | "S" => Some(Camera::Other),
        _ => None,
    }
}

/// From DJI's `drone-dji:ImageSource` XMP value. None when the text holds none.
fn camera_from_xmp(head: &[u8]) -> Option<Camera> {
    const TAG: &[u8] = b"ImageSource";
    let at = head.windows(TAG.len()).position(|w| w == TAG)?;
    let value = &head[at + TAG.len()..];
    let value = String::from_utf8_lossy(&value[..value.len().min(48)]).to_ascii_lowercase();
    if value.contains("infrared") || value.contains("thermal") {
        Some(Camera::Thermal)
    } else if value.contains("wide") || value.contains("visible") {
        Some(Camera::World)
    } else if value.contains("zoom") {
        Some(Camera::Other)
    } else {
        None
    }
}

/// The camera a photo came from; anything that does not say is an ordinary RGB photo.
pub fn camera_of(path: &Path) -> Camera {
    if let Some(camera) = camera_from_name(path) {
        return camera;
    }
    let mut head = Vec::new();
    let read = fs::File::open(path).and_then(|f| f.take(XMP_PROBE_BYTES).read_to_end(&mut head));
    match read {
        Ok(_) => camera_from_xmp(&head).unwrap_or(Camera::World),
        Err(_) => Camera::World,
    }
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_none_or(|n| n.starts_with('.'))
}

/// The photos of one flight, sorted by camera.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Flight {
    /// The folder's name: the name a project made from it gets.
    pub name: String,
    /// The folder as shown in a list, relative to the picked folder.
    pub label: String,
    pub thermal: Vec<String>,
    pub world: Vec<String>,
}

impl Flight {
    pub fn into_project(self) -> Project {
        Project::new(self.thermal, self.world)
    }
}

/// What the frontend shows of a flight to choose from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightSummary {
    pub label: String,
    pub thermal: usize,
    pub world: usize,
}

impl From<&Flight> for FlightSummary {
    fn from(flight: &Flight) -> Self {
        FlightSummary {
            label: flight.label.clone(),
            thermal: flight.thermal.len(),
            world: flight.world.len(),
        }
    }
}

/// The usable photos directly inside one folder.
#[derive(Debug, Default)]
struct FolderPhotos {
    dir: PathBuf,
    thermal: Vec<PathBuf>,
    world: Vec<PathBuf>,
}

impl FolderPhotos {
    /// The one camera all photos here came from, if it is one.
    fn single(&self) -> Option<Camera> {
        match (self.thermal.is_empty(), self.world.is_empty()) {
            (false, true) => Some(Camera::Thermal),
            (true, false) => Some(Camera::World),
            _ => None,
        }
    }
}

fn walk(
    dir: &Path,
    depth: usize,
    count: &mut usize,
    out: &mut Vec<FolderPhotos>,
) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(()); // unreadable folders are skipped
    };
    let mut here = FolderPhotos {
        dir: dir.to_path_buf(),
        ..FolderPhotos::default()
    };
    let mut folders = Vec::new();
    for entry in entries.flatten() {
        if is_hidden(&entry.file_name()) {
            continue;
        }
        // file_type() does not follow symlinks, so links are skipped (no loops).
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            folders.push(path);
        } else if file_type.is_file() && is_image(&path) {
            *count += 1;
            if *count > MAX_PHOTOS {
                return Err(format!(
                    "That folder holds more than {MAX_PHOTOS} photos; pick the folder of one survey"
                ));
            }
            match camera_of(&path) {
                Camera::Thermal => here.thermal.push(path),
                Camera::World => here.world.push(path),
                Camera::Other => {}
            }
        }
    }
    if !here.thermal.is_empty() || !here.world.is_empty() {
        out.push(here);
    }
    if depth < MAX_DEPTH {
        folders.sort();
        for folder in folders {
            walk(&folder, depth + 1, count, out)?;
        }
    }
    Ok(())
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

fn is_camera_folder(path: &Path) -> bool {
    CAMERA_FOLDERS.contains(&folder_name(path).to_ascii_lowercase().as_str())
}

/// What a flight in `dir` is called: a camera folder that was picked itself is one half
/// of the flight above it.
fn flight_name(dir: &Path) -> String {
    let flight = dir
        .parent()
        .filter(|_| is_camera_folder(dir))
        .unwrap_or(dir);
    folder_name(flight)
}

/// The folder that stands for the flight a photo folder belongs to: the folder itself,
/// or the one above it when it only holds one camera's half of that flight.
fn flight_folder(root: &Path, folder: &FolderPhotos, all: &[FolderPhotos]) -> PathBuf {
    let dir = &folder.dir;
    let Some(parent) = dir.parent().filter(|_| dir != root) else {
        return dir.clone();
    };
    if is_camera_folder(dir) {
        return parent.to_path_buf();
    }
    // Two folders next to each other, one all thermal and one all RGB, with any names.
    let mut siblings = all
        .iter()
        .filter(|other| other.dir != *dir && other.dir.parent() == Some(parent));
    let pair = match (folder.single(), siblings.next(), siblings.next()) {
        (Some(mine), Some(other), None) => other.single().is_some_and(|theirs| theirs != mine),
        _ => false,
    };
    if pair {
        parent.to_path_buf()
    } else {
        dir.clone()
    }
}

/// Finds the flights in `root` (searched a few folders deep), in natural order.
pub fn scan_folder(root: &Path) -> Result<Vec<Flight>, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("Could not open that folder: {e}"))?;
    let mut folders = Vec::new();
    walk(&root, 0, &mut 0, &mut folders)?;

    let mut flights: BTreeMap<PathBuf, (Vec<PathBuf>, Vec<PathBuf>)> = BTreeMap::new();
    for folder in &folders {
        let (thermal, world) = flights
            .entry(flight_folder(&root, folder, &folders))
            .or_default();
        thermal.extend(folder.thermal.iter().cloned());
        world.extend(folder.world.iter().cloned());
    }
    let mut flights: Vec<Flight> = flights
        .into_iter()
        .map(|(dir, (thermal, world))| Flight {
            name: flight_name(&dir),
            label: match dir.strip_prefix(&root) {
                Ok(rest) if !rest.as_os_str().is_empty() => rest.to_string_lossy().into_owned(),
                _ => folder_name(&dir),
            },
            thermal: project::dedupe_and_sort(thermal),
            world: project::dedupe_and_sort(world),
        })
        .collect();
    flights.sort_by(|a, b| project::natural_cmp(&a.label, &b.label));
    Ok(flights)
}

/// Sorts hand-picked photos by camera. Nothing is left out: a zoom photo that was picked
/// on purpose counts as an RGB photo.
pub fn sort_photos(photos: Vec<PathBuf>) -> (Vec<PathBuf>, Vec<PathBuf>) {
    photos
        .into_iter()
        .partition(|path| camera_of(path) == Camera::Thermal)
}

/// The project name for photos picked by hand: the folder they are in (or the one above
/// a camera folder). None when there is no such folder.
pub fn name_for_photos(photos: &[String]) -> Option<String> {
    let folder = Path::new(photos.first()?).parent()?;
    let folder = if is_camera_folder(folder) {
        folder.parent()?
    } else {
        folder
    };
    Some(folder_name(folder)).filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "terra-scan-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    fn touch(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn names(paths: &[String]) -> Vec<String> {
        paths.iter().map(|p| folder_name(Path::new(p))).collect()
    }

    #[test]
    fn dji_names_say_the_camera() {
        let camera = |name: &str| camera_from_name(Path::new(name));
        assert_eq!(
            camera("/a/DJI_20260413144926_0001_T.JPG"),
            Some(Camera::Thermal)
        );
        assert_eq!(
            camera("/a/DJI_20260413144926_0001_W.JPG"),
            Some(Camera::World)
        );
        assert_eq!(camera("/a/dji_0001_v.jpg"), Some(Camera::World));
        assert_eq!(camera("/a/DJI_0001_Z.JPG"), Some(Camera::Other));
        assert_eq!(camera("/a/DJI_0001.JPG"), None);
        assert_eq!(camera("/a/field_T.JPG"), None, "only DJI's own names count");
        assert_eq!(camera("/a/DJI_0001_T"), Some(Camera::Thermal));
    }

    #[test]
    fn xmp_says_the_camera() {
        let xmp =
            |source: &str| format!(r#"<x drone-dji:ImageSource="{source}" tiff:Model="ZH20T"/>"#);
        assert_eq!(
            camera_from_xmp(xmp("InfraredCamera").as_bytes()),
            Some(Camera::Thermal)
        );
        assert_eq!(
            camera_from_xmp(xmp("WideCamera").as_bytes()),
            Some(Camera::World)
        );
        assert_eq!(
            camera_from_xmp(xmp("ZoomCamera").as_bytes()),
            Some(Camera::Other)
        );
        assert_eq!(camera_from_xmp(xmp("Something").as_bytes()), None);
        assert_eq!(camera_from_xmp(b"\xff\xd8 no metadata"), None);
        assert_eq!(camera_from_xmp(b"ImageSource"), None);

        let d = temp_dir("xmp");
        let renamed = d.join("flight_0001.jpg");
        touch(&renamed, xmp("InfraredCamera").as_bytes());
        assert_eq!(camera_of(&renamed), Camera::Thermal);
        let plain = d.join("holiday.jpg");
        touch(&plain, b"\xff\xd8");
        assert_eq!(camera_of(&plain), Camera::World);
        assert_eq!(camera_of(&d.join("missing.jpg")), Camera::World);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn one_folder_with_both_cameras_mixed() {
        let d = temp_dir("mixed");
        let root = d.join("09A");
        for i in [2, 10, 1] {
            touch(&root.join(format!("DJI_{i:04}_T.JPG")), b"");
            touch(&root.join(format!("DJI_{i:04}_W.JPG")), b"");
        }
        touch(&root.join("DJI_0001_Z.JPG"), b"");
        touch(&root.join("notes.txt"), b"");
        touch(&root.join("._DJI_0001_T.JPG"), b"");
        let flights = scan_folder(&root).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!(
            (flights[0].name.as_str(), flights[0].label.as_str()),
            ("09A", "09A")
        );
        assert_eq!(
            names(&flights[0].thermal),
            ["DJI_0001_T.JPG", "DJI_0002_T.JPG", "DJI_0010_T.JPG"]
        );
        assert_eq!(flights[0].world.len(), 3, "the zoom photo is left out");
        let project = flights[0].clone().into_project();
        assert_eq!(project.kind, project::Kind::Thermal);
        assert_eq!(project.world_images.len(), 3);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_folder_per_camera_is_one_flight() {
        let d = temp_dir("split");
        let root = d.join("44");
        touch(&root.join("T/DJI_0001_T.JPG"), b"");
        touch(&root.join("T/DJI_0002_T.JPG"), b"");
        touch(&root.join("W/DJI_0001_W.JPG"), b"");
        let flights = scan_folder(&root).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!(flights[0].name, "44");
        assert_eq!((flights[0].thermal.len(), flights[0].world.len()), (2, 1));

        // Picking the camera folder itself gives just that camera, named after the flight.
        let flights = scan_folder(&root.join("T")).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!(
            (flights[0].name.as_str(), flights[0].label.as_str()),
            ("44", "T")
        );
        assert_eq!(flights[0].world.len(), 0);
        assert_eq!(name_for_photos(&flights[0].thermal), Some("44".to_string()));

        // Any two folder names work when one is all thermal and the other all RGB.
        let odd = d.join("polder");
        touch(&odd.join("warmte/DJI_0001_T.JPG"), b"");
        touch(&odd.join("kleur/DJI_0001_W.JPG"), b"");
        let flights = scan_folder(&odd).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!(flights[0].name, "polder");
        assert_eq!((flights[0].thermal.len(), flights[0].world.len()), (1, 1));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn several_flights_are_listed_in_natural_order() {
        let d = temp_dir("flights");
        let root = d.join("wilhelmbos");
        for flight in ["62C", "9A", "40"] {
            touch(&root.join(flight).join("DJI_0001_T.JPG"), b"");
            touch(&root.join(flight).join("DJI_0001_W.JPG"), b"");
        }
        // Two thermal-only flights next to each other stay two flights.
        touch(&root.join("extra/a/DJI_0001_T.JPG"), b"");
        touch(&root.join("extra/b/DJI_0001_T.JPG"), b"");
        touch(&root.join(".hidden/DJI_0001_T.JPG"), b"");
        let flights = scan_folder(&root).unwrap();
        let labels: Vec<&str> = flights.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, ["9A", "40", "62C", "extra/a", "extra/b"]);
        assert_eq!(flights[4].name, "b");
        let summary = FlightSummary::from(&flights[0]);
        assert_eq!((summary.thermal, summary.world), (1, 1));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rgb_only_and_empty_folders() {
        let d = temp_dir("rgb");
        touch(&d.join("field/IMG_0001.jpg"), b"\xff\xd8");
        touch(&d.join("field/IMG_0002.PNG"), b"\x89PNG");
        let flights = scan_folder(&d.join("field")).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!((flights[0].thermal.len(), flights[0].world.len()), (0, 2));
        let project = flights[0].clone().into_project();
        assert_eq!(project.kind, project::Kind::World);
        assert_eq!((project.images.len(), project.world_images.len()), (2, 0));

        fs::create_dir(d.join("empty")).unwrap();
        assert!(scan_folder(&d.join("empty")).unwrap().is_empty());
        assert!(scan_folder(&d.join("missing")).is_err());

        // Too deep to be found.
        touch(&d.join("deep/1/2/3/4/5/DJI_0001_T.JPG"), b"");
        assert!(scan_folder(&d.join("deep")).unwrap().is_empty());
        touch(&d.join("deep/1/2/3/4/DJI_0001_T.JPG"), b"");
        assert_eq!(scan_folder(&d.join("deep")).unwrap().len(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn hand_picked_photos_are_sorted_and_named() {
        let (thermal, world) = sort_photos(vec![
            PathBuf::from("/s/44/DJI_0001_T.JPG"),
            PathBuf::from("/s/44/DJI_0001_W.JPG"),
            PathBuf::from("/s/44/DJI_0001_Z.JPG"),
        ]);
        assert_eq!(thermal, [PathBuf::from("/s/44/DJI_0001_T.JPG")]);
        assert_eq!(world.len(), 2, "a hand-picked zoom photo is kept");
        assert_eq!(
            name_for_photos(&["/s/44/DJI_0001_T.JPG".to_string()]),
            Some("44".to_string())
        );
        assert_eq!(
            name_for_photos(&["/s/44/W/DJI_0001_W.JPG".to_string()]),
            Some("44".to_string())
        );
        assert_eq!(name_for_photos(&["/DJI_0001_T.JPG".to_string()]), None);
        assert_eq!(name_for_photos(&[]), None);
    }
}
