# Terra

Terra is a macOS desktop app for measuring water surface area from drone surveys.

1. Pick a set of overlapping nadir photos from one DJI flight (thermal `_T` or visible `_V`/`_W` images, not both).
2. Terra stitches them into one north-up panorama with a bundled Python script (OpenCV via the [`stitching`](https://github.com/OpenStitching/stitching) package). For DJI photos, the GPS position, altitude and gimbal yaw in each image's metadata place the images, so long survey strips do not bend.
3. Click the water colour on the panorama. Terra counts the matching pixels and converts them to hectares using the ground sampling distance (GSD).
4. Name the project in the breadcrumb and use the download menu to save `orthomosaic_<name>-ir.tif` (GeoTIFF, WGS84), `polygon_<name>.kmz` (water mask) and `hectare_<name>.txt` (area) to `Documents/Terra/<name>`. The GeoTIFF and KMZ need a panorama stitched from photos with GPS data.

Built with Tauri v2 (Rust), React 19, Vite and TypeScript.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) 22+ and [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- Python 3.10+ with the stitcher packages (see below)

## Development

```sh
pnpm install
pnpm tauri dev      # run the app with hot reload
pnpm tauri build    # build a release .app / .dmg
```

## Python setup

The stitcher is `src-tauri/python/photo_stitcher.py`. Its dependencies (`stitching`, which brings in OpenCV, plus `numpy` and `Pillow`) are listed in `src-tauri/python/requirements.txt`. Install them in a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r src-tauri/python/requirements.txt
```

Terra uses the first interpreter that can import `stitching`, `cv2` and `numpy` (Pillow is optional but recommended: it makes reading image sizes faster), trying in this order: `TERRA_PYTHON`, the project's `.venv/bin/python3` (development builds only), `/Library/Frameworks/Python.framework/Versions/Current/bin/python3` (python.org installer), `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3` on `PATH`, and finally `/usr/bin/python3` (only when Xcode or the Command Line Tools are installed). The result is remembered until the app quits.

To choose the interpreter Terra runs, set `TERRA_PYTHON` to its full path:

```sh
TERRA_PYTHON="$PWD/.venv/bin/python" pnpm tauri dev
```

An app started from Finder or the Dock does not get your shell's environment. To set the variable for apps started that way (until you log out):

```sh
launchctl setenv TERRA_PYTHON "/full/path/to/.venv/bin/python"
```

Avoid `/usr/bin/python3` on machines without the Xcode Command Line Tools. That path is a stub that opens the "install command line developer tools" dialog.

### Running the stitcher by hand

```sh
python3 -u src-tauri/python/photo_stitcher.py --input stitch_input.json --output-dir out/
```

`stitch_input.json` looks like `{"images": ["/abs/path/DJI_0001_T.JPG", ...]}`. The script writes progress lines to stderr. On success, it writes `panorama.png` (RGBA, transparent where there is no image data) and then `result.json`. On a handled error, it prints `ERROR: <reason>` as its last line, exits with code 2 and normally leaves the previous output untouched. (In the unlikely case that saving fails while the new `panorama.png` and `result.json` are being moved into place, the old `result.json` is already removed, so no panorama is shown until the next stitch.)

`TERRA_NEIGHBOUR_RADIUS` (default `0.5`) controls which image pairs are matched: only pairs whose GPS positions are closer than this fraction of an image's ground footprint.

## Where Terra stores its data

Terra writes nothing into the source tree. The project state and stitch output go in the app data folder:

```
~/Library/Application Support/com.chrisvandeneijnden.terra-app/
  project.json        the selected images
  stitch_input.json   input for the current/last stitch
  panorama.png        the last successful panorama
  result.json         metadata of that panorama (size, included images, GSD, scale)
```

Delete the folder to reset Terra.

## GSD and area

The GSD field is the size of one **source-image** pixel on the ground, in metres (the camera GSD). When the photos carry DJI GPS metadata, Terra measures the GSD from the GPS distances between consecutive shots on straight flight lines and pre-fills it (marked "est."). Shots taken while the drone turns are not used for this, so a small selection around a turn may have too few usable pairs; then no estimate is given and the stitcher asks you to enter the GSD yourself. Images that don't match any other image reliably are left out of the panorama, and the log says how many. The panorama can be scaled relative to the source images (`pano_scale`, panorama pixels per source pixel; about 1.0 for GPS-aligned panoramas). Terra uses that scale to convert:

```
panorama GSD = GSD / pano_scale
area (ha)    = selected pixels × panorama GSD² / 10 000
```

DJI's `RelativeAltitude` is the height above the take-off point. Over sloped terrain, or when the flight altitude changes, a single GSD for the whole panorama is less accurate, and the stitcher warns about this.
