//! Project storage in the app data directory.
//!
//! Files (all in `app_data_dir`):
//! - `project.json`       written only by Rust: `{"images": [...]}`
//! - `stitch_input.json`  written by Rust right before running Python: `{"images": [...]}`
//! - `panorama.png`       written by Python (atomically)
//! - `result.json`        written by Python last, only on success
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

pub const PROJECT_FILE: &str = "project.json";
pub const STITCH_INPUT_FILE: &str = "stitch_input.json";
pub const PANORAMA_FILE: &str = "panorama.png";
pub const RESULT_FILE: &str = "result.json";

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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub images: Vec<String>,
    pub panorama: Option<PanoramaInfo>,
    pub stitching: bool,
}

/// `project.json` / `stitch_input.json` contents.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImageList {
    #[serde(default)]
    pub images: Vec<String>,
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

/// Loads result.json from `dir` and turns it into a PanoramaInfo.
/// Ignored (None) when result.json is missing or corrupt, when the panorama file is
/// missing, or when the PNG on disk does not match the recorded size (e.g. a run that
/// replaced panorama.png but died before writing its result.json).
pub fn load_panorama(dir: &Path) -> Option<PanoramaInfo> {
    let text = fs::read_to_string(dir.join(RESULT_FILE)).ok()?;
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
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(PanoramaInfo {
        path: r.panorama,
        mtime_ms,
        width: r.width,
        height: r.height,
        images: r.images,
        included_images: r.included_images,
        gps_aligned: r.gps_aligned,
        estimated_gsd: if r.gps_aligned { r.estimated_gsd } else { None },
        pano_scale: r.pano_scale,
    })
}

/// Forgets the current panorama (result.json first, so nothing points at a missing file).
pub fn delete_panorama(dir: &Path) -> io::Result<()> {
    for name in [RESULT_FILE, PANORAMA_FILE] {
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
        let is_known =
            [PROJECT_FILE, STITCH_INPUT_FILE, PANORAMA_FILE, RESULT_FILE].contains(&name);
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
pub fn load_images(dir: &Path) -> Vec<String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Object(ImageList),
        Array(Vec<String>),
    }
    let Ok(text) = fs::read_to_string(dir.join(PROJECT_FILE)) else {
        return Vec::new();
    };
    match serde_json::from_str::<Stored>(&text) {
        Ok(Stored::Object(list)) => list.images,
        Ok(Stored::Array(images)) => images,
        Err(e) => {
            eprintln!("[terra] ignoring corrupt {PROJECT_FILE}: {e}");
            Vec::new()
        }
    }
}

pub fn save_images(dir: &Path, images: &[String]) -> io::Result<()> {
    write_image_list(&dir.join(PROJECT_FILE), images)
}

pub fn write_image_list(path: &Path, images: &[String]) -> io::Result<()> {
    let list = ImageList {
        images: images.to_vec(),
    };
    let json = serde_json::to_vec_pretty(&list).map_err(io::Error::other)?;
    write_atomic(path, &json)
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
        assert!(load_images(&d).is_empty(), "missing file is empty");
        let imgs = vec!["/x/DJI_0001.JPG".to_string(), "/x/DJI_0002.JPG".to_string()];
        save_images(&d, &imgs).unwrap();
        assert_eq!(load_images(&d), imgs);
        let text = fs::read_to_string(d.join(PROJECT_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["images"][1], "/x/DJI_0002.JPG");
        // No temp files left behind.
        let names: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![PROJECT_FILE.to_string()]);

        fs::write(d.join(PROJECT_FILE), b"{\"images\": [").unwrap();
        assert!(load_images(&d).is_empty(), "corrupt file is empty");
        fs::write(d.join(PROJECT_FILE), b"[\"/a.jpg\"]").unwrap();
        assert_eq!(load_images(&d), vec!["/a.jpg".to_string()]);
        fs::write(d.join(PROJECT_FILE), b"{}").unwrap();
        assert!(load_images(&d).is_empty());
        fs::remove_dir_all(d).unwrap();
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
        let json = serde_json::to_value(&info).unwrap();
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
