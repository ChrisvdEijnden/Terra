# Terra

Terra is a macOS desktop app for measuring water surface area from drone surveys.

1. Open the folder of one DJI flight with overlapping nadir photos. Terra sorts the photos itself: thermal ones (`_T`) are measured on, the visible-light ones of the wide camera (`_W`/`_V`, called *world* photos here) go along, and zoom photos (`_Z`) are left out. The two kinds may be mixed in one folder or sit in a folder each (`44/T`, `44/W`). A folder that holds several flights gives a list to choose from, and photos can still be picked by hand. A folder with only RGB photos works too: those are then measured on.
2. Terra stitches the thermal photos into one north-up panorama with a bundled Python script (OpenCV via the [`stitching`](https://github.com/OpenStitching/stitching) package). For DJI photos, the GPS position, altitude and gimbal yaw in each image's metadata place the images, so long survey strips do not bend.
3. Click the water colour on the panorama. Terra counts the matching pixels and converts them to hectares using the ground sampling distance (GSD).
4. The Thermal / World switch at the bottom shows the world photos in place of the thermal panorama, with the water mask on top. The world mosaic is only stitched the first time it is asked for (by the switch or by a download), at about twice the detail of the thermal panorama; that takes a few minutes. Each world photo is placed where its thermal twin (the photo of the same shot) landed in the thermal panorama, and Terra works out from the photos how far the wide camera is tilted and how far apart the two cameras look, so the two mosaics line up to within a few decimetres. Measuring the distance between the cameras takes a flight with lines flown both ways: when all photos face the same way it is left out. When the world photos do not match each other well enough, they are placed at their twins without either correction, and when there are too few twins, by their own GPS. When the thermal panorama itself does not fit together everywhere (flight lines stitched apart), the world photos cannot follow it there. In those cases the two mosaics can be a metre or more apart, and the app says so when it shows the world view. Without map coordinates on the thermal panorama there is no world view.
5. The project is named after the folder (rename it in the breadcrumb). The download menu saves `orthomosaic_<name>_T.tif` and `orthomosaic_<name>_W.tif` (GeoTIFF, WGS84), `polygon_<name>.kmz` (water mask) and `hectare_<name>.txt` (area) to `Documents/Terra/<name>`. The GeoTIFFs and the KMZ need a panorama stitched from photos with GPS data.

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

`stitch_input.json` looks like `{"images": ["/abs/path/DJI_0001_T.JPG", ...]}`. Three optional keys are what Terra adds for the world mosaic: `"target_gsd"` (metres per panorama pixel to aim for; photos are scaled down to about that), `"view"` (also save the mosaic on the map frame of another panorama, so the two can be shown on top of each other) and `"align_to"` (the `result.json` of the panorama stitched from the other camera's photos of the same flight: each photo is then placed where its twin, the photo with the same shot number and time in the file name, landed there, and the offset and tilt between the two cameras are solved from the matches). `result.json` lists under `"poses"` where every included photo landed (`lon`/`lat` of its centre and `yaw` of its top edge, next to its GPS tags `gps_lon`/`gps_lat`/`gps_yaw`), and `"aligned"` says whether the photos were lined up with the other panorama including the offset between the cameras. Without `target_gsd`, photos larger than 2 megapixels are scaled down to that size. `--panorama-name` and `--result-name` change the names of the two output files. The script writes progress lines to stderr. On success, it writes `panorama.png` (RGBA, transparent where there is no image data) and then `result.json`. On a handled error, it prints `ERROR: <reason>` as its last line, exits with code 2 and normally leaves the previous output untouched. (In the unlikely case that saving fails while the new `panorama.png` and `result.json` are being moved into place, the old `result.json` is already removed, so no panorama is shown until the next stitch.)

`TERRA_NEIGHBOUR_RADIUS` (default `0.5`) controls which image pairs are matched: only pairs whose GPS positions are closer than this fraction of an image's ground footprint.

## Where Terra stores its data

Terra writes nothing into the source tree. The project state and stitch output go in the app data folder:

```
~/Library/Application Support/com.chrisvandeneijnden.terra-app/
  project.json        the selected images: the ones measured on, and the world photos
  stitch_input.json   input for the current/last stitch
  panorama.png        the last successful panorama
  result.json         metadata of that panorama (size, included images, GSD, scale,
                      where each photo landed; the world mosaic is placed by that)
  world_input.json    the same three files for the world mosaic,
  world.png           which exists once it has been asked for
  world_result.json
  world_view.webp     the world mosaic on the frame of panorama.png, as the app shows it
```

Delete the folder to reset Terra.

## GSD and area

The GSD field is the size of one **source-image** pixel on the ground, in metres (the camera GSD). When the photos carry DJI GPS metadata, Terra measures the GSD from the GPS distances between consecutive shots on straight flight lines and pre-fills it (marked "est."). Shots taken while the drone turns are not used for this, so a small selection around a turn may have too few usable pairs; then no estimate is given and the stitcher asks you to enter the GSD yourself. Images that don't match any other image reliably are left out of the panorama, and the log says how many. The panorama can be scaled relative to the source images (`pano_scale`, panorama pixels per source pixel; about 1.0 for GPS-aligned panoramas). Terra uses that scale to convert:

```
panorama GSD = GSD / pano_scale
area (ha)    = selected pixels × panorama GSD² / 10 000
```

DJI's `RelativeAltitude` is the height above the take-off point. Over sloped terrain, or when the flight altitude changes, a single GSD for the whole panorama is less accurate, and the stitcher warns about this.
