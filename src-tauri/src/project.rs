//! Project storage in the app data directory.
//!
//! Files (all in `app_data_dir`):
//! - `project.json`       written only by Rust: `{"images": [...], "world_images": [...],
//!   "kind": "thermal"}`. `images` is the set that is measured on: the thermal photos, or
//!   the RGB photos when there are no thermal ones. `world_images` are the RGB photos that
//!   go with thermal ones.
//! - `stitch_input.json`  written by Rust right before running Python: `{"images": [...]}`
//! - `panorama.png`       written by Python (atomically), stitched from `images`
//! - `result.json`        written by Python last, only on success
//! - `world_input.json`, `world.png`, `world_result.json`: the same three for the world
//!   mosaic, stitched from `world_images` only when it is asked for
//! - `world_view.webp`    written by Python with `world.png`: the world mosaic on the frame
//!   of `panorama.png`, so the app can show it in place of the panorama
//! - `project_name.txt`   written only by Rust; absent while the project has no name
//!
//! Everything here is plain std code so it can be unit tested without a Tauri app.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::scan::Camera;

pub const PROJECT_FILE: &str = "project.json";
pub const STITCH_INPUT_FILE: &str = "stitch_input.json";
pub const PANORAMA_FILE: &str = "panorama.png";
pub const RESULT_FILE: &str = "result.json";
pub const WORLD_INPUT_FILE: &str = "world_input.json";
pub const WORLD_PANORAMA_FILE: &str = "world.png";
pub const WORLD_RESULT_FILE: &str = "world_result.json";
pub const WORLD_VIEW_FILE: &str = "world_view.webp";
pub const PROJECT_NAME_FILE: &str = "project_name.txt";

/// The name ends up in file and folder names, so it has to stay reasonably short.
const MAX_NAME_CHARS: usize = 100;

/// GDAL-style [lon0, dlon, 0, lat0, 0, dlat]: pixel-edge (col, row) to WGS84 degrees.
pub type GeoTransform = [f64; 6];

/// Which camera a set of photos came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Thermal,
    /// Visible light (RGB): DJI's wide camera, or any other ordinary photo.
    World,
}

/// Which of the two mosaics a stitch makes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StitchTarget {
    /// The one that is measured on, from `images`.
    #[default]
    Primary,
    /// The RGB mosaic that goes with a thermal one, from `world_images`.
    World,
}

impl StitchTarget {
    pub fn input_file(self) -> &'static str {
        match self {
            StitchTarget::Primary => STITCH_INPUT_FILE,
            StitchTarget::World => WORLD_INPUT_FILE,
        }
    }

    pub fn panorama_file(self) -> &'static str {
        match self {
            StitchTarget::Primary => PANORAMA_FILE,
            StitchTarget::World => WORLD_PANORAMA_FILE,
        }
    }

    pub fn result_file(self) -> &'static str {
        match self {
            StitchTarget::Primary => RESULT_FILE,
            StitchTarget::World => WORLD_RESULT_FILE,
        }
    }
}

/// What the frontend gets for a stitched panorama.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanoramaInfo {
    pub path: String,
    pub mtime_ms: u64,
    pub width: u32,
    pub height: u32,
    pub images: Vec<String>,
    pub included_images: Vec<String>,
    pub gps_aligned: bool,
    pub estimated_gsd: Option<f64>,
    pub pano_scale: Option<f64>,
    /// True when the panorama can be placed on a map.
    pub georeferenced: bool,
    /// True when its photos were lined up with another panorama of the flight (the world
    /// mosaic with the thermal one); false when they are placed by their own GPS, or at
    /// their twins without the camera offset, and may be a few metres off.
    pub aligned: bool,
    #[serde(skip)]
    pub geotransform: Option<GeoTransform>,
    #[serde(skip)]
    pub view: Option<ViewResult>,
}

impl PanoramaInfo {
    /// Metres on the ground per panorama pixel, when GPS gave the scale.
    pub fn metres_per_pixel(&self) -> Option<f64> {
        Some(self.estimated_gsd? / self.pano_scale?)
    }

    /// Where the panorama lies on the map.
    pub fn frame(&self) -> Option<MapFrame> {
        Some(MapFrame {
            geotransform: self.geotransform?,
            width: self.width,
            height: self.height,
        })
    }
}

/// The piece of the map a panorama covers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MapFrame {
    pub geotransform: GeoTransform,
    pub width: u32,
    pub height: u32,
}

impl MapFrame {
    /// True for the same frame, after a trip through JSON: serde_json does not always read
    /// back the last digit of the numbers it wrote. What this allows is far less than a
    /// millimetre on the ground.
    pub fn same_as(&self, other: &MapFrame) -> bool {
        self.width == other.width
            && self.height == other.height
            && self
                .geotransform
                .iter()
                .zip(other.geotransform.iter())
                .all(|(a, b)| (a - b).abs() <= 1e-12 * a.abs().max(b.abs()))
    }
}

/// `view` in a result file: the mosaic resampled onto the frame of another panorama.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ViewResult {
    pub path: String,
    pub frame: MapFrame,
}

/// What the frontend gets to show the world mosaic in place of the panorama.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldView {
    pub path: String,
    pub mtime_ms: u64,
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The world mosaic's view, when it was made for the frame of the current panorama (a
/// panorama that was stitched again since lies elsewhere) and from the current photos.
pub fn world_view(
    panorama: Option<&PanoramaInfo>,
    world: Option<&PanoramaInfo>,
    world_images: &[String],
) -> Option<WorldView> {
    let world = world?;
    let view = world.view.as_ref()?;
    if !view.frame.same_as(&panorama?.frame()?) || !same_set(&world.images, world_images) {
        return None;
    }
    let meta = fs::metadata(&view.path).ok().filter(|m| m.is_file())?;
    Some(WorldView {
        path: view.path.clone(),
        mtime_ms: mtime_ms(&meta),
    })
}

/// True when both lists hold the same paths, in any order.
pub fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && {
        let set: HashSet<&String> = a.iter().collect();
        b.iter().all(|path| set.contains(path))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    /// None until the user names the project.
    pub name: Option<String>,
    /// The photos that are measured on.
    pub images: Vec<String>,
    /// What `images` are.
    pub kind: Kind,
    /// The RGB photos that go with thermal `images`.
    pub world_images: Vec<String>,
    pub panorama: Option<PanoramaInfo>,
    pub world_panorama: Option<PanoramaInfo>,
    /// The world mosaic as it can be shown over `panorama`; None until it is stitched
    /// for this panorama and these photos.
    pub world_view: Option<WorldView>,
    /// The mosaic that is being stitched right now, if any.
    pub stitching: Option<StitchTarget>,
}

/// The photos of a project.
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    pub images: Vec<String>,
    pub kind: Kind,
    pub world_images: Vec<String>,
}

impl Default for Project {
    fn default() -> Self {
        Project::new(Vec::new(), Vec::new())
    }
}

impl Project {
    /// Thermal photos are what gets measured; without them the RGB photos are.
    pub fn new(thermal: Vec<String>, world: Vec<String>) -> Self {
        if thermal.is_empty() {
            Project {
                images: world,
                kind: Kind::World,
                world_images: Vec::new(),
            }
        } else {
            Project {
                images: thermal,
                kind: Kind::Thermal,
                world_images: world,
            }
        }
    }

    pub fn images_for(&self, target: StitchTarget) -> &[String] {
        match target {
            StitchTarget::Primary => &self.images,
            StitchTarget::World => &self.world_images,
        }
    }
}

/// `project.json` contents.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct ProjectFile {
    #[serde(default)]
    images: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    world_images: Vec<String>,
    /// Absent in files written before the world photos were added.
    #[serde(default)]
    kind: Option<Kind>,
}

/// `result.json` as written by photo_stitcher.py (snake_case keys).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StitchResult {
    pub panorama: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub included_images: Vec<String>,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub gps_aligned: bool,
    #[serde(default)]
    pub estimated_gsd: Option<f64>,
    #[serde(default)]
    pub pano_scale: Option<f64>,
    /// Absent in result.json files written before map coordinates were added.
    #[serde(default)]
    pub geotransform: Option<GeoTransform>,
    #[serde(default)]
    pub view: Option<ViewResult>,
    /// Absent in result.json files written before the world mosaic was lined up.
    #[serde(default)]
    pub aligned: bool,
}

/// Keeps only finite, strictly positive numbers.
fn positive(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x > 0.0)
}

/// Parses result.json text. Returns None for anything malformed.
pub fn parse_result(text: &str) -> Option<StitchResult> {
    let mut r: StitchResult = serde_json::from_str(text).ok()?;
    if r.panorama.is_empty() || r.width == 0 || r.height == 0 {
        return None;
    }
    r.estimated_gsd = positive(r.estimated_gsd);
    r.pano_scale = positive(r.pano_scale);
    r.geotransform = r
        .geotransform
        .filter(|g| g.iter().all(|v| v.is_finite()) && g[1] != 0.0 && g[5] != 0.0);
    Some(r)
}

/// Reads width/height from a PNG header (IHDR). None if the file is not a PNG.
pub fn png_dimensions(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut header = [0u8; 24];
    fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(header[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(header[20..24].try_into().ok()?);
    Some((w, h))
}

/// The panorama that is measured on.
pub fn load_panorama(dir: &Path) -> Option<PanoramaInfo> {
    load_mosaic(dir, StitchTarget::Primary)
}

/// Loads the target's result file from `dir` and turns it into a PanoramaInfo.
/// Ignored (None) when the result file is missing or corrupt, when the panorama file is
/// missing, or when the PNG on disk does not match the recorded size (e.g. a run that
/// replaced panorama.png but died before writing its result.json).
pub fn load_mosaic(dir: &Path, target: StitchTarget) -> Option<PanoramaInfo> {
    let text = fs::read_to_string(dir.join(target.result_file())).ok()?;
    let r = parse_result(&text)?;
    let path = PathBuf::from(&r.panorama);
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    if let Some((w, h)) = png_dimensions(&path) {
        if (w, h) != (r.width, r.height) {
            return None;
        }
    }
    let geotransform = if r.gps_aligned { r.geotransform } else { None };
    Some(PanoramaInfo {
        path: r.panorama,
        mtime_ms: mtime_ms(&meta),
        width: r.width,
        height: r.height,
        images: r.images,
        included_images: r.included_images,
        gps_aligned: r.gps_aligned,
        estimated_gsd: if r.gps_aligned { r.estimated_gsd } else { None },
        pano_scale: r.pano_scale,
        georeferenced: geotransform.is_some(),
        aligned: r.aligned && geotransform.is_some(),
        geotransform,
        view: r.view,
    })
}

/// Makes a typed project name safe to use as a folder and inside file names: no path
/// separators or characters Finder and other systems reject, no hidden names, no "..".
/// Empty means there is no usable name.
pub fn sanitize_project_name(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || r#"/\:*?"<>|"#.contains(c) {
                '-'
            } else {
                c
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    replaced
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string()
}

pub fn load_name(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(PROJECT_NAME_FILE)).ok()?;
    let name = sanitize_project_name(&text);
    (!name.is_empty()).then_some(name)
}

/// Stores a sanitized project name; an empty name forgets the current one.
pub fn save_name(dir: &Path, name: &str) -> io::Result<()> {
    let path = dir.join(PROJECT_NAME_FILE);
    if !name.is_empty() {
        return write_atomic(&path, name.as_bytes());
    }
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Forgets both mosaics (each result file first, so nothing points at a missing file).
pub fn delete_panorama(dir: &Path) -> io::Result<()> {
    for name in [
        RESULT_FILE,
        PANORAMA_FILE,
        WORLD_RESULT_FILE,
        WORLD_PANORAMA_FILE,
        WORLD_VIEW_FILE,
    ] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Removes leftover temporary files (from a killed or failed run) in our data dir.
pub fn cleanup_temp_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let is_known = [
            PROJECT_FILE,
            STITCH_INPUT_FILE,
            PANORAMA_FILE,
            RESULT_FILE,
            WORLD_INPUT_FILE,
            WORLD_PANORAMA_FILE,
            WORLD_RESULT_FILE,
            WORLD_VIEW_FILE,
        ]
        .contains(&name);
        if !is_known
            && name.contains("tmp")
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Loads project.json. A missing or corrupt file is an empty project.
/// Also accepts a bare JSON array of paths.
pub fn load_project(dir: &Path) -> Project {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Object(ProjectFile),
        Array(Vec<String>),
    }
    let Ok(text) = fs::read_to_string(dir.join(PROJECT_FILE)) else {
        return Project::default();
    };
    let file = match serde_json::from_str::<Stored>(&text) {
        Ok(Stored::Object(file)) => file,
        Ok(Stored::Array(images)) => ProjectFile {
            images,
            ..ProjectFile::default()
        },
        Err(e) => {
            eprintln!("[terra] ignoring corrupt {PROJECT_FILE}: {e}");
            return Project::default();
        }
    };
    // Older files do not say what the photos are; DJI marks thermal ones in the name.
    let kind = file.kind.unwrap_or_else(|| {
        let thermal =
            |path: &String| crate::scan::camera_from_name(Path::new(path)) == Some(Camera::Thermal);
        if file.images.iter().any(thermal) {
            Kind::Thermal
        } else {
            Kind::World
        }
    });
    Project {
        // RGB photos have no world set of their own.
        world_images: if kind == Kind::Thermal {
            file.world_images
        } else {
            Vec::new()
        },
        images: file.images,
        kind,
    }
}

pub fn save_project(dir: &Path, project: &Project) -> io::Result<()> {
    let file = ProjectFile {
        images: project.images.clone(),
        world_images: project.world_images.clone(),
        kind: Some(project.kind),
    };
    let json = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
    write_atomic(&dir.join(PROJECT_FILE), &json)
}

/// Writes `bytes` to a temp file in the same directory, fsyncs it and renames it over
/// `path`, so readers see either the old or the new file, never a half-written one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad file name"))?;
    let n = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    let tmp = dir.join(format!(".{name}.tmp-{}-{n}", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Compares strings in "natural" order: digit runs compare by numeric value, so
/// `DJI_0002` < `DJI_0010`. Text runs compare case-insensitively; full ties fall back
/// to a plain byte comparison so the order is total.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    fn chunks(s: &str) -> Vec<(bool, &str)> {
        let mut out = Vec::new();
        let mut start = 0;
        let mut prev: Option<bool> = None;
        for (i, c) in s.char_indices() {
            let d = c.is_ascii_digit();
            if let Some(p) = prev {
                if p != d {
                    out.push((p, &s[start..i]));
                    start = i;
                }
            }
            prev = Some(d);
        }
        if let Some(p) = prev {
            out.push((p, &s[start..]));
        }
        out
    }
    let (ca, cb) = (chunks(a), chunks(b));
    for (x, y) in ca.iter().zip(cb.iter()) {
        let ord = match (x, y) {
            ((true, x), (true, y)) => {
                let (xt, yt) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                xt.len().cmp(&yt.len()).then_with(|| xt.cmp(yt))
            }
            ((_, x), (_, y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    ca.len().cmp(&cb.len()).then_with(|| a.cmp(b))
}

/// Canonicalizes, drops duplicates (by canonical path) and non-UTF-8 paths, and sorts
/// naturally. Paths that cannot be canonicalized (e.g. deleted since) are kept as given.
pub fn dedupe_and_sort<I: IntoIterator<Item = PathBuf>>(paths: I) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        let canon = fs::canonicalize(&p).unwrap_or(p);
        let Some(s) = canon.to_str() else { continue };
        if seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out.sort_by(|a, b| natural_cmp(a, b));
    out
}

/// load_image allow-check: `requested` may be read only if it resolves to the same
/// file as one of `allowed` (the current image set and the current panorama).
/// Returns the canonical path to read.
pub fn allowed_path<'a, I>(requested: &Path, allowed: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = &'a str>,
{
    let req = fs::canonicalize(requested).ok()?;
    allowed
        .into_iter()
        .filter_map(|a| fs::canonicalize(a).ok())
        .any(|a| a == req)
        .then_some(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "terra-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    fn touch(p: &Path) {
        fs::write(p, b"x").unwrap();
    }

    #[test]
    fn natural_order() {
        let mut v = vec![
            "DJI_0010_T.JPG",
            "DJI_0002_T.JPG",
            "dji_0003_T.JPG",
            "DJI_0001_T.JPG",
            "DJI_00002_T.JPG",
        ];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            [
                "DJI_0001_T.JPG",
                "DJI_00002_T.JPG",
                "DJI_0002_T.JPG",
                "dji_0003_T.JPG",
                "DJI_0010_T.JPG"
            ]
        );
        assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "a1"), Ordering::Less);
        assert_eq!(natural_cmp("", ""), Ordering::Equal);
        // Numbers longer than u64 must not overflow.
        assert_eq!(
            natural_cmp("x99999999999999999999999", "x100000000000000000000000"),
            Ordering::Less
        );
    }

    #[test]
    fn dedupe_by_canonical_path_and_sort() {
        let d = temp_dir("dedupe");
        let a = d.join("DJI_0010.JPG");
        let b = d.join("DJI_0002.JPG");
        touch(&a);
        touch(&b);
        fs::create_dir(d.join("sub")).unwrap();
        let via_dotdot = d.join("sub").join("..").join("DJI_0010.JPG");
        #[cfg(unix)]
        let link = {
            let l = d.join("link.JPG");
            std::os::unix::fs::symlink(&b, &l).unwrap();
            l
        };
        #[cfg(not(unix))]
        let link = b.clone();
        let missing = d.join("DJI_0005.JPG");
        let out = dedupe_and_sort(vec![
            a.clone(),
            via_dotdot,
            b.clone(),
            link,
            missing.clone(),
        ]);
        assert_eq!(
            out,
            vec![
                b.to_str().unwrap().to_string(),
                missing.to_str().unwrap().to_string(),
                a.to_str().unwrap().to_string(),
            ]
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn load_image_allow_check() {
        let d = temp_dir("allow");
        let img = d.join("a.jpg");
        let other = d.join("secret.txt");
        touch(&img);
        touch(&other);
        fs::create_dir(d.join("sub")).unwrap();
        let img_s = img.to_str().unwrap();
        assert_eq!(allowed_path(&img, [img_s]), Some(img.clone()));
        assert_eq!(
            allowed_path(&d.join("sub/../a.jpg"), [img_s]),
            Some(img.clone())
        );
        assert_eq!(allowed_path(&other, [img_s]), None);
        assert_eq!(allowed_path(&d.join("sub/../secret.txt"), [img_s]), None);
        assert_eq!(allowed_path(&d.join("nope.jpg"), [img_s]), None);
        assert_eq!(allowed_path(&img, std::iter::empty::<&str>()), None);
        #[cfg(unix)]
        {
            let link = d.join("link.jpg");
            std::os::unix::fs::symlink(&other, &link).unwrap();
            // A symlink to a non-allowed file is refused.
            assert_eq!(allowed_path(&link, [img_s]), None);
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_roundtrip_and_corrupt_files() {
        let d = temp_dir("project");
        assert_eq!(
            load_project(&d),
            Project::default(),
            "missing file is empty"
        );
        assert_eq!(Project::default().kind, Kind::World);
        let imgs = vec!["/x/DJI_0001.JPG".to_string(), "/x/DJI_0002.JPG".to_string()];
        let rgb = Project::new(Vec::new(), imgs.clone());
        save_project(&d, &rgb).unwrap();
        assert_eq!(load_project(&d), rgb);
        assert_eq!((rgb.kind, rgb.world_images.len()), (Kind::World, 0));
        let text = fs::read_to_string(d.join(PROJECT_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["images"][1], "/x/DJI_0002.JPG");
        assert_eq!(v["kind"], "world");
        assert!(v.get("world_images").is_none());
        // No temp files left behind.
        let names: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![PROJECT_FILE.to_string()]);

        fs::write(d.join(PROJECT_FILE), b"{\"images\": [").unwrap();
        assert!(load_project(&d).images.is_empty(), "corrupt file is empty");
        fs::write(d.join(PROJECT_FILE), b"[\"/a.jpg\"]").unwrap();
        assert_eq!(load_project(&d).images, vec!["/a.jpg".to_string()]);
        fs::write(d.join(PROJECT_FILE), b"{}").unwrap();
        assert!(load_project(&d).images.is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn thermal_photos_are_measured_and_rgb_ones_go_along() {
        let d = temp_dir("kinds");
        let thermal = vec![
            "/x/DJI_0001_T.JPG".to_string(),
            "/x/DJI_0002_T.JPG".to_string(),
        ];
        let world = vec![
            "/x/DJI_0001_W.JPG".to_string(),
            "/x/DJI_0002_W.JPG".to_string(),
        ];
        let both = Project::new(thermal.clone(), world.clone());
        assert_eq!(both.kind, Kind::Thermal);
        assert_eq!(both.images_for(StitchTarget::Primary), thermal);
        assert_eq!(both.images_for(StitchTarget::World), world);
        save_project(&d, &both).unwrap();
        assert_eq!(load_project(&d), both);

        // Written before the world photos were added: the names say what they are.
        fs::write(
            d.join(PROJECT_FILE),
            br#"{"images": ["/x/DJI_0001_T.JPG"]}"#,
        )
        .unwrap();
        assert_eq!(load_project(&d).kind, Kind::Thermal);
        fs::write(
            d.join(PROJECT_FILE),
            br#"{"images": ["/x/DJI_0001_W.JPG"]}"#,
        )
        .unwrap();
        assert_eq!(load_project(&d).kind, Kind::World);
        fs::write(
            d.join(PROJECT_FILE),
            br#"{"images": ["/a.jpg"], "world_images": ["/b.jpg"], "kind": "world"}"#,
        )
        .unwrap();
        assert!(
            load_project(&d).world_images.is_empty(),
            "RGB photos have no world set"
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn project_names_are_safe_for_the_file_system() {
        assert_eq!(sanitize_project_name("  Polder Zuid  "), "Polder Zuid");
        assert_eq!(sanitize_project_name("a/b\\c:d"), "a-b-c-d");
        assert_eq!(sanitize_project_name("../../etc"), "-..-etc");
        assert_eq!(sanitize_project_name("..."), "");
        assert_eq!(sanitize_project_name(".hidden."), "hidden");
        assert_eq!(sanitize_project_name("line\nbreak"), "line-break");
        assert_eq!(sanitize_project_name("v1.2"), "v1.2");
        assert_eq!(
            sanitize_project_name(&"é".repeat(MAX_NAME_CHARS + 20))
                .chars()
                .count(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn project_name_roundtrip() {
        let d = temp_dir("name");
        assert_eq!(load_name(&d), None, "no file yet");
        save_name(&d, "Polder").unwrap();
        assert_eq!(load_name(&d), Some("Polder".to_string()));
        save_name(&d, "").unwrap();
        assert_eq!(load_name(&d), None, "an empty name forgets it");
        save_name(&d, "").unwrap();
        fs::write(d.join(PROJECT_NAME_FILE), "a/b").unwrap();
        assert_eq!(
            load_name(&d),
            Some("a-b".to_string()),
            "a hand-edited file cannot escape the folder"
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn geotransform_parsing() {
        let parse = |g: &str| {
            let text = format!(r#"{{"panorama": "/p.png", "width": 1, "height": 1, {g}}}"#);
            parse_result(&text).unwrap().geotransform
        };
        assert_eq!(
            parse(r#""geotransform": [5.3, 0.001, 0, 52.2, 0, -0.001]"#),
            Some([5.3, 0.001, 0.0, 52.2, 0.0, -0.001])
        );
        assert_eq!(parse(r#""geotransform": null"#), None);
        assert_eq!(parse(r#""gps_aligned": true"#), None, "older result.json");
        assert_eq!(
            parse(r#""geotransform": [5.3, 0, 0, 52.2, 0, -0.001]"#),
            None,
            "a zero pixel size cannot be a map"
        );
    }

    #[test]
    fn result_json_parsing() {
        let full = r#"{"panorama": "/d/panorama.png", "images": ["/a", "/b"],
            "included_images": ["/a"], "width": 100, "height": 50, "gps_aligned": true,
            "estimated_gsd": 0.12, "pano_scale": 0.5}"#;
        let r = parse_result(full).unwrap();
        assert_eq!(r.width, 100);
        assert_eq!(r.included_images, vec!["/a".to_string()]);
        assert!(r.gps_aligned);
        assert_eq!(r.estimated_gsd, Some(0.12));
        assert_eq!(r.pano_scale, Some(0.5));

        let nulls = r#"{"panorama": "/d/panorama.png", "images": [], "included_images": [],
            "width": 10, "height": 20, "gps_aligned": false, "estimated_gsd": null,
            "pano_scale": null}"#;
        let r = parse_result(nulls).unwrap();
        assert_eq!(
            (r.estimated_gsd, r.pano_scale, r.gps_aligned),
            (None, None, false)
        );

        let minimal = r#"{"panorama": "/p.png", "width": 1, "height": 1}"#;
        let r = parse_result(minimal).unwrap();
        assert!(r.images.is_empty());
        assert_eq!(r.estimated_gsd, None);

        let nonpositive = r#"{"panorama": "/p.png", "width": 1, "height": 1,
            "estimated_gsd": 0, "pano_scale": -1}"#;
        let r = parse_result(nonpositive).unwrap();
        assert_eq!((r.estimated_gsd, r.pano_scale), (None, None));

        assert!(parse_result("").is_none());
        assert!(parse_result("[]").is_none());
        assert!(parse_result(r#"{"panorama": "/p.png", "width": 0, "height": 1}"#).is_none());
        assert!(parse_result(r#"{"panorama": "", "width": 1, "height": 1}"#).is_none());
        assert!(parse_result(r#"{"width": 1, "height": 1}"#).is_none());
    }

    #[test]
    fn world_mosaic_and_its_view() {
        let d = temp_dir("world");
        let write_result = |target: StitchTarget, size: (u32, u32), extra: &str| {
            let path = d.join(target.panorama_file());
            write_png_header(&path, size.0, size.1);
            let text = format!(
                r#"{{"panorama": {:?}, "images": ["/w1", "/w2"], "width": {}, "height": {},
                "gps_aligned": true, "estimated_gsd": 0.02, "pano_scale": 0.5,
                "geotransform": [5.3, 0.000001, 0, 52.2, 0, -0.000001]{extra}}}"#,
                path.to_str().unwrap(),
                size.0,
                size.1
            );
            fs::write(d.join(target.result_file()), text).unwrap();
        };
        let photos = vec!["/w2".to_string(), "/w1".to_string()];
        assert!(load_mosaic(&d, StitchTarget::World).is_none());

        write_result(StitchTarget::Primary, (30, 20), "");
        let panorama = load_panorama(&d).unwrap();
        assert_eq!(panorama.metres_per_pixel(), Some(0.04));
        let frame = panorama.frame().unwrap();
        assert_eq!(
            (frame.width, frame.height, frame.geotransform[3]),
            (30, 20, 52.2)
        );

        // Stitched without a view: it can be saved, not shown.
        write_result(StitchTarget::World, (60, 40), "");
        let world = load_mosaic(&d, StitchTarget::World).unwrap();
        assert_eq!((world.width, world.height), (60, 40));
        assert!(!world.aligned, "a result without the key was not lined up");
        assert_eq!(world_view(Some(&panorama), Some(&world), &photos), None);
        write_result(StitchTarget::World, (60, 40), r#", "aligned": true"#);
        assert!(load_mosaic(&d, StitchTarget::World).unwrap().aligned);

        let view = d.join(WORLD_VIEW_FILE);
        let with_view = |frame_width: u32| {
            format!(
                r#", "view": {{"path": {:?}, "width": 45, "height": 30, "frame": {{"geotransform":
                [5.3, 0.000001, 0, 52.2, 0, -0.000001], "width": {frame_width}, "height": 20}}}}"#,
                view.to_str().unwrap()
            )
        };
        write_result(StitchTarget::World, (60, 40), &with_view(30));
        let world = load_mosaic(&d, StitchTarget::World).unwrap();
        assert_eq!(
            world_view(Some(&panorama), Some(&world), &photos),
            None,
            "view file missing"
        );
        touch(&view);
        let shown = world_view(Some(&panorama), Some(&world), &photos).unwrap();
        assert_eq!(shown.path, view.to_str().unwrap());
        assert!(shown.mtime_ms > 0);
        assert_eq!(world_view(None, Some(&world), &photos), None);
        assert_eq!(world_view(Some(&panorama), None, &photos), None);
        assert_eq!(
            world_view(Some(&panorama), Some(&world), &["/w1".to_string()]),
            None,
            "made from other photos"
        );

        // Made for a panorama that was stitched again since.
        write_result(StitchTarget::World, (60, 40), &with_view(31));
        let world = load_mosaic(&d, StitchTarget::World).unwrap();
        assert_eq!(world_view(Some(&panorama), Some(&world), &photos), None);

        // The frame read back from JSON may differ in the last digit, not by a millimetre.
        let a = MapFrame {
            geotransform: [5.3, 1e-6, 0.0, 52.2, 0.0, -4.5590364173465446e-7],
            width: 30,
            height: 20,
        };
        let mut b = a.clone();
        b.geotransform[5] = -4.559036417346545e-7;
        assert!(a.same_as(&b) && b.same_as(&a));
        b.geotransform[3] += 1e-8; // about a millimetre north
        assert!(!a.same_as(&b));
        assert!(!a.same_as(&MapFrame {
            width: 31,
            ..a.clone()
        }));

        delete_panorama(&d).unwrap();
        let left: Vec<_> = fs::read_dir(&d).unwrap().collect();
        assert!(left.is_empty(), "both mosaics and the view are gone");
        fs::remove_dir_all(d).unwrap();
    }

    fn write_png_header(path: &Path, w: u32, h: u32) {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::write(path, b).unwrap();
    }

    #[test]
    fn panorama_loading() {
        let d = temp_dir("pano");
        assert!(load_panorama(&d).is_none(), "no result.json");
        let pano = d.join(PANORAMA_FILE);
        let result = format!(
            r#"{{"panorama": {:?}, "images": ["/a", "/b"], "included_images": ["/a", "/b"],
            "width": 30, "height": 20, "gps_aligned": false, "estimated_gsd": 0.1,
            "pano_scale": 0.25}}"#,
            pano.to_str().unwrap()
        );
        fs::write(d.join(RESULT_FILE), &result).unwrap();
        assert!(load_panorama(&d).is_none(), "panorama file missing");

        write_png_header(&pano, 30, 20);
        let info = load_panorama(&d).unwrap();
        assert_eq!(info.path, pano.to_str().unwrap());
        assert_eq!((info.width, info.height), (30, 20));
        assert!(info.mtime_ms > 0);
        assert_eq!(info.pano_scale, Some(0.25));
        assert_eq!(info.estimated_gsd, None, "GSD only trusted on the GPS path");
        assert!(!info.georeferenced);
        assert_eq!((info.metres_per_pixel(), info.frame()), (None, None));
        let json = serde_json::to_value(&info).unwrap();
        assert!(
            json.get("geotransform").is_none() && json.get("view").is_none(),
            "the transform stays in Rust"
        );
        assert!(json.get("mtimeMs").is_some() && json.get("includedImages").is_some());
        assert!(json["estimatedGsd"].is_null());

        write_png_header(&pano, 31, 20);
        assert!(load_panorama(&d).is_none(), "size mismatch");

        delete_panorama(&d).unwrap();
        assert!(!pano.exists() && !d.join(RESULT_FILE).exists());
        delete_panorama(&d).unwrap();

        touch(&d.join("tmpab12.png"));
        touch(&d.join(".panorama.png.tmp-1"));
        touch(&d.join(PROJECT_FILE));
        cleanup_temp_files(&d);
        let names: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![PROJECT_FILE.to_string()]);
        fs::remove_dir_all(d).unwrap();
    }
}
