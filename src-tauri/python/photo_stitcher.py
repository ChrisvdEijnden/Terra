"""Terra photo stitcher.

Stitches nadir drone photos (DJI) into one north-up panorama.

    python3 -u photo_stitcher.py --input <dir>/stitch_input.json --output-dir <dir>
        [--panorama-name panorama.png] [--result-name result.json]

Input:  {"images": ["/abs/a.JPG", ...]} and optionally
  "target_gsd": 0.044   metres per panorama pixel to aim for (photos are scaled down to
                        about that, never up). Without it, photos larger than
                        DEFAULT_MAX_MEGAPIX are scaled down to that size.
  "view": {"name": "world_view.webp", "geotransform": [...], "width": 100, "height": 50}
                        also save this panorama resampled onto the map frame of another
                        panorama (its geotransform and size), to show the two on top of
                        each other. Needs GPS; "view" in result.json is null without it.
  "align_to": "/abs/result.json"
                        the result file of another panorama of the same flight, made
                        from the photos another camera took of the same shots (thermal
                        and wide ones). These photos are then placed where their twins
                        landed in that panorama instead of by their own GPS, so the two
                        panoramas line up ("aligned" in result.json says whether they do).
Output (in --output-dir, only on success):
  panorama.png  RGBA; alpha 255 where there is image data, 0 where there is none
  result.json   {"panorama", "images", "included_images", "width", "height", "poses",
                 "gps_aligned", "estimated_gsd", "pano_scale", "geotransform", "aligned"}
                 estimated_gsd: metres per full-resolution source-image pixel (GPS path only)
                 pano_scale:    panorama pixels per full-resolution source-image pixel
                 geotransform:  GDAL-style [lon0, dlon, 0, lat0, 0, dlat] in WGS84 degrees,
                                from pixel-edge (col, row) to (lon, lat) (GPS path only)

Progress goes to stderr, one short line per event. A handled failure ends with
"ERROR: <sentence>" on stderr and exit code 2; normally nothing is written in
that case, so the previous panorama/result stay intact (if saving fails while the
new files are moved into place, the old result.json is already removed and no
panorama is shown). If the process is killed while it
saves, the previous panorama can be lost, but it is never paired with the wrong
result.json.
"""

import argparse
import calendar
import json
import math
import os
import re
import sys
import tempfile
import time
import traceback
import warnings
from statistics import median

try:
    import cv2
    import numpy as np
    from stitching import AffineStitcher
    from stitching.images import Images
    from stitching.stitching_error import StitchingError, StitchingWarning
    from stitching.subsetter import Subsetter
    from stitching.warper import Warper
except ImportError as exc:  # pragma: no cover - depends on the environment
    _requirements = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements.txt")
    _packages = f'-r "{_requirements}"' if os.path.isfile(_requirements) else '"stitching>=0.7,<0.8" numpy Pillow'
    print(
        f"ERROR: The Python package '{exc.name}' is not installed for {sys.executable}; "
        f"install the stitcher requirements with: {sys.executable} -m pip install {_packages}",
        file=sys.stderr,
    )
    sys.exit(2)

try:
    from PIL import Image as PILImage
except ImportError:  # Pillow is optional; OpenCV can still read sizes (slower)
    PILImage = None

# Only match image pairs whose GPS centres are closer than this fraction of the
# short side of one image's ground footprint (0.5 -> pairs overlap >= ~50%).
# Override with the TERRA_NEIGHBOUR_RADIUS environment variable.
DEFAULT_NEIGHBOUR_RADIUS = 0.5

# DJI puts its XMP block near the start of the file; skip the (radiometric) payload.
HEAD_BYTES = 512 * 1024

PANORAMA_NAME = "panorama.png"
RESULT_NAME = "result.json"

# Without a target GSD, photos are blended at no more than this many megapixels each, so a
# set of 12-48 MP RGB photos gives a panorama the app can still show and measure on
# (thermal photos are smaller than this).
DEFAULT_MAX_MEGAPIX = 2.0
# Lining a second set of photos up with the panorama of the first (GpsLayout.align_to):
# how closely each photo is held to where its twin landed, and how far apart the two
# cameras may look (a constant offset in the picture, solved along). Held tightly: wide
# photos match each other so well that, held more loosely (0.2 m), each flight line kept
# its own shape, up to half a metre along the line off the thermal panorama, which
# follows GPS more closely; the second panorama has to lie on the first.
ALIGN_SIGMA_M = 0.05
ALIGN_YAW_SIGMA = 0.01  # radians
ALIGN_OFFSET_SIGMA_M = 5.0
# ... and how far off straight down the camera may look (radians); solved along too,
# because the same tilt that moves the picture centre bends the edges of a wide picture
# by a metre, which the matches between flight lines then hold against the other panorama.
# (Solved as well when the matches of a stitch do not fit together without it.)
TILT_SIGMA = 0.05
# Two photos of one shot are taken within a second or so (rarely tens of seconds apart in
# the file names): further apart in place or time, they are not twins (another flight).
MAX_TWIN_DISTANCE_M = 20.0
MAX_TWIN_SECONDS = 120.0
MIN_TWINS = 3
# The camera offset can only be told from a shift of the whole mosaic when the photos
# face different ways (a lawnmower flight): not when the mean of their headings, as unit
# vectors, is longer than this (1 = all one way, 0 = as many one way as the other).
MAX_HEADING_CONCENTRATION = 0.8
# A solved tilt beyond this (degrees) is not a drone camera looking down; such a solve is
# not trusted.
MAX_TILT_DEG = 5.0
# Lined up photos that their matches turn further than this (median, degrees) away from
# their twins show that the other panorama does not fit together: thermal panoramas whose
# flight lines were stitched 2 m apart gave 0.7, sound ones 0.05-0.2.
MAX_TWIN_TURN_DEG = 0.5

# A view with more pixels than this is slow to load and to move around in the app.
VIEW_MAX_PIXELS = 48e6
VIEW_QUALITY = 85
WEBP_MAX_SIDE = 16383


class UserError(Exception):
    """A failure we can explain to the user in one sentence."""


def log(message):
    print(message, file=sys.stderr, flush=True)


def example(paths):
    return os.path.basename(paths[0]) if paths else ""


def neighbour_radius():
    """TERRA_NEIGHBOUR_RADIUS as a positive number (a decimal comma is accepted)."""
    raw = os.environ.get("TERRA_NEIGHBOUR_RADIUS", "").strip()
    if not raw:
        return DEFAULT_NEIGHBOUR_RADIUS
    try:
        value = float(raw.replace(",", "."))
    except ValueError:
        value = math.nan
    if not (math.isfinite(value) and value > 0):
        raise UserError("TERRA_NEIGHBOUR_RADIUS must be a positive number, for example 0.5.")
    return value


# --------------------------------------------------------------------------- metadata

_XMP_ATTR = re.compile(rb'drone-dji:(\w+)\s*=\s*"([^"]*)"')
_XMP_ELEM = re.compile(rb"<drone-dji:(\w+)>([^<]*)</drone-dji:\1>")
_XMP_F35 = re.compile(rb'FocalLengthIn35mm(?:Format|Film)\s*(?:=\s*"|>)\s*(\d+(?:\.\d+)?)')

# DJI firmware spells these differently across models (including the famous typo).
_LAT_KEYS = ("gpslatitude", "latitude")
_LON_KEYS = ("gpslongitude", "gpslongtitude", "longitude", "longtitude")
_ALT_KEYS = ("relativealtitude",)
_YAW_KEYS = ("gimbalyawdegree",)
_FLIGHT_YAW_KEYS = ("flightyawdegree",)


def _xmp_number(xmp, keys):
    for key in keys:
        value = xmp.get(key)
        if value is None:
            continue
        try:
            number = float(value)
        except ValueError:
            continue
        if math.isfinite(number):
            return number
    return None


def _exif_degrees(dms, ref):
    try:
        deg = float(dms[0]) + float(dms[1]) / 60 + float(dms[2]) / 3600
    except (TypeError, ValueError, IndexError, ZeroDivisionError):
        return None
    if not math.isfinite(deg):
        return None
    return -deg if str(ref).strip().upper() in ("S", "W") else deg


def _no_fix(lat, lon):
    """DJI writes 0/0 for shots taken before the GPS lock; that is no position at all."""
    return lat is None or lon is None or (abs(lat) < 1e-6 and abs(lon) < 1e-6)


class ImageInfo:
    """Size and DJI metadata of one image, read from its header only."""

    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        self.size = None  # (width, height) as OpenCV will decode it
        self.lat = self.lon = self.rel_alt = self.yaw = self.flight_yaw = self.f35 = None
        self.time = None  # EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS"), sorts chronologically


def inspect_image(path):
    info = ImageInfo(path)
    if not os.path.isfile(path):
        raise UserError(f"Image not found: {path}")
    try:
        with open(path, "rb") as f:
            head = f.read(HEAD_BYTES)
    except OSError as exc:
        raise UserError(f"Cannot read {info.name}: {exc.strerror or exc}") from None

    xmp = {}
    for key, value in _XMP_ATTR.findall(head) + _XMP_ELEM.findall(head):
        xmp.setdefault(key.decode("ascii", "replace").lower(), value.decode("utf-8", "replace").strip())
    info.lat = _xmp_number(xmp, _LAT_KEYS)
    info.lon = _xmp_number(xmp, _LON_KEYS)
    if _no_fix(info.lat, info.lon):
        info.lat = info.lon = None
    info.rel_alt = _xmp_number(xmp, _ALT_KEYS)
    info.yaw = _xmp_number(xmp, _YAW_KEYS)
    info.flight_yaw = _xmp_number(xmp, _FLIGHT_YAW_KEYS)
    m = _XMP_F35.search(head)
    if m and float(m.group(1)) > 0:
        info.f35 = float(m.group(1))

    if PILImage is not None:
        try:
            with PILImage.open(path) as im:  # lazy: reads the header, not the pixels
                w, h = im.size
                try:
                    exif = im.getexif()
                except Exception:
                    exif = None
                if exif:
                    if exif.get(0x0112) in (5, 6, 7, 8):  # OpenCV applies EXIF rotation
                        w, h = h, w
                    try:
                        exif_ifd = exif.get_ifd(0x8769)
                        taken = exif_ifd.get(0x9003) or exif.get(0x0132)
                        info.time = str(taken).strip() if taken else None
                        if info.f35 is None:
                            f35 = exif_ifd.get(0xA405)
                            info.f35 = float(f35) if f35 and float(f35) > 0 else None
                        if info.lat is None or info.lon is None:
                            gps = exif.get_ifd(0x8825)
                            lat = _exif_degrees(gps.get(2), gps.get(1, "N")) if gps.get(2) else None
                            lon = _exif_degrees(gps.get(4), gps.get(3, "E")) if gps.get(4) else None
                            if not _no_fix(lat, lon):
                                info.lat, info.lon = lat, lon
                    except Exception:
                        pass
                info.size = (w, h)
        except Exception:
            info.size = None
    if info.size is None:
        img = cv2.imread(path)  # Pillow could not parse it; let OpenCV decide
        if img is None:
            raise UserError(f"Cannot read {info.name}: it is not a supported image file")
        info.size = (img.shape[1], img.shape[0])
    return info


_SHOT = re.compile(r"(?:^|_)(?:(\d{14})_)?(\d+)_[A-Za-z]+$")


def shot_key(path):
    """The shot number in a DJI file name (DJI_<time>_<shot>_<camera>): the photos that
    the cameras of one gimbal took of the same shot share it. None for other names."""
    m = _SHOT.search(os.path.splitext(os.path.basename(path))[0])
    return int(m.group(2)) if m else None


def shot_time(path):
    """The capture time in a DJI file name (DJI_<YYYYMMDDhhmmss>_...) in seconds, None when
    the name has none. Tells the shots of two flights of one mission apart."""
    m = _SHOT.search(os.path.splitext(os.path.basename(path))[0])
    if not m or not m.group(1):
        return None
    try:
        return float(calendar.timegm(time.strptime(m.group(1), "%Y%m%d%H%M%S")))
    except (ValueError, OverflowError):
        return None


def check_same_size(infos):
    groups = {}
    for info in infos:
        groups.setdefault(info.size, []).append(info)
    if len(groups) == 1:
        return infos[0].size
    parts = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    desc = ", ".join(f"{len(g)} x {w}x{h} (e.g. {g[0].name})" for (w, h), g in parts)
    raise UserError(
        f"The selected images have different sizes: {desc}. Pick images from one camera only, "
        "for example only the _T (thermal) or only the _V/_W (visible) files."
    )


# --------------------------------------------------------------------------- GPS layout


class GpsLayout:
    """Ground position (metres east/north), gimbal yaw and approximate GSD per image."""

    def __init__(self, infos, image_size):
        self.paths = [i.path for i in infos]
        self.index = {p: k for k, p in enumerate(self.paths)}
        self.valid = False
        self.aligned = False  # positions and yaws come from another panorama (align_to)
        self.align_reason = None  # why align_to could not line the photos up
        self.twin = None  # per image: it has a twin there (the others go by their neighbours)
        self.yaw = None
        self.tag_yaw = None  # the gimbal yaw as tagged (yaw itself may be corrected)
        self.reason = None  # why the GPS layout is not used
        self.yaw_reason = None  # why the GPS+yaw refinement is not used
        self.warnings = []
        n = len(infos)

        no_pos = [i.name for i in infos if i.lat is None or i.lon is None]
        no_alt = [i.name for i in infos if i.rel_alt is None]
        problems = []
        if no_pos:
            problems.append(f"{len(no_pos)} of {n} images have no GPS position (e.g. {no_pos[0]})")
        if no_alt:
            problems.append(f"{len(no_alt)} of {n} images have no DJI RelativeAltitude (e.g. {no_alt[0]})")
        if problems:
            self.reason = "; ".join(problems)
            return

        lat = np.array([i.lat for i in infos])
        lon = np.array([i.lon for i in infos])
        # local east/north metres from the WGS84 meridian (m) and normal (nu) radii at lat0
        lat0 = math.radians(lat.mean())
        a, f = 6378137.0, 1 / 298.257223563
        e2 = f * (2 - f)
        den = 1 - e2 * math.sin(lat0) ** 2
        m, nu = a * (1 - e2) / den ** 1.5, a / math.sqrt(den)
        self.lonlat = np.c_[lon, lat]  # as tagged, degrees
        self.origin = (float(lon.mean()), float(lat.mean()))  # where xy == (0, 0)
        self.metres_per_degree = (math.radians(1) * nu * math.cos(lat0), math.radians(1) * m)  # east, north
        self.xy = np.c_[
            np.radians(lon - lon.mean()) * nu * math.cos(lat0),
            np.radians(lat - lat.mean()) * m,
        ]

        # capture order (EXIF time, then file name; else the order given), for
        # "consecutive shots" below
        if all(i.time for i in infos):
            self.order = sorted(range(n), key=lambda k: (infos[k].time, infos[k].name))
        else:
            self.order = list(range(n))
        self.rank = np.empty(n, np.int64)
        self.rank[self.order] = np.arange(n)

        # RelativeAltitude is the height above the TAKE-OFF point, not above the ground
        # under each photo, so on sloped terrain (or if the drone climbed) it is only a
        # first guess. It sets the neighbour radius and the starting scale; the
        # estimated GSD is calibrated against the GPS distances between consecutive
        # shots instead (gps_scale).
        alts = np.array([i.rel_alt for i in infos])
        alt = float(np.median(alts))
        self.altitude = alt
        if alt <= 1.0:
            self.reason = f"RelativeAltitude is not usable (median {alt:.1f} m)"
            return
        spread = float(alts.max() - alts.min())
        if spread > 0.10 * alt:
            self.warnings.append(
                f"Flight altitude varies from {alts.min():.0f} to {alts.max():.0f} m above take-off; "
                "a single scale for the whole panorama is less accurate"
            )

        w, h = image_size
        self.full_w = w
        f35s = [i.f35 for i in infos if i.f35]
        if f35s:
            ground_w = alt * 36 / median(f35s)  # nadir footprint width from 35mm-equivalent focal length
        else:
            ground_w = alt * 1.15  # rough fallback (~60 deg horizontal FOV)
            self.warnings.append("No 35mm focal length in the metadata; assuming a ~60 degree field of view")
        self.gsd = ground_w / w  # metres per full-resolution pixel (first guess)
        self.short_side = ground_w * min(w, h) / w

        no_yaw = [i.name for i in infos if i.yaw is None]
        if no_yaw:
            self.yaw_reason = f"{len(no_yaw)} of {n} images have no GimbalYawDegree (e.g. {no_yaw[0]})"
        else:
            self.yaw = np.array([i.yaw for i in infos])
            self.tag_yaw = self.yaw.copy()
        self.turn = self._find_turns(infos)
        self.valid = True

    def _find_turns(self, infos, max_yaw_step=5.0, max_heading_change=5.0):
        """Boolean per image: taken while the aircraft turned. There the GPS position
        and the photo do not belong to quite the same moment, so baselines to these
        shots are biased. Compares each shot with its neighbours in capture order:
        a gimbal or aircraft yaw step, or a bend in the GPS track.
        (Gimbal yaw minus aircraft yaw is not used: it is constant but non-zero on
        straight lines, e.g. ~6 degrees with a cross wind.)"""
        n = len(infos)
        turn = np.zeros(n, bool)
        order = self.order

        def step(values, a, b):
            if values[a] is None or values[b] is None:
                return 0.0
            return abs((values[b] - values[a] + 180) % 360 - 180)

        gimbal = [i.yaw for i in infos]
        flight = [i.flight_yaw for i in infos]
        for a, b in zip(order, order[1:]):
            if max(step(gimbal, a, b), step(flight, a, b)) > max_yaw_step:
                turn[a] = turn[b] = True
        for a, b, c in zip(order, order[1:], order[2:]):
            d1, d2 = self.xy[b] - self.xy[a], self.xy[c] - self.xy[b]
            if min(np.hypot(*d1), np.hypot(*d2)) < 1.0:
                continue  # too short to give a heading
            bend = math.degrees(abs(math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1 @ d2)))
            if bend > max_heading_change:
                turn[b] = True
        return turn

    def align_to(self, poses):
        """Moves every photo to where its twin landed in another panorama of this flight.

        `poses` is the "poses" list of that panorama's result file (GpsStitcher.poses).
        A twin is the photo another camera took of the same shot (same shot number in
        the name, taken at about the same time and tagged close by). What the matches of
        that panorama corrected on the twin's tagged position and yaw is applied to this
        photo's own tags, which already hold the distance flown between the two
        exposures. Photos without a twin get the correction of their neighbours in time.
        Returns the number of twins; 0 means nothing was changed (align_reason says why).
        """
        if poses is None:
            self.align_reason = "the other panorama does not say where its photos are; stitch it again first"
            return 0
        if not self.valid or self.yaw is None:
            self.align_reason = self.reason or self.yaw_reason
            return 0
        per_lon, per_lat = self.metres_per_degree
        by_shot = {}
        for pose in poses:
            by_shot.setdefault(shot_key(pose["image"]), []).append(pose)
        n = len(self.paths)
        shift, turn, found = np.zeros((n, 2)), np.zeros(n), np.zeros(n, bool)
        for i, path in enumerate(self.paths):
            key = shot_key(path)
            if key is None:
                continue
            when = shot_time(path)
            best = None
            for pose in by_shot.get(key, ()):
                gap = math.hypot((pose["gps_lon"] - self.lonlat[i, 0]) * per_lon,
                                 (pose["gps_lat"] - self.lonlat[i, 1]) * per_lat)
                other = shot_time(pose["image"])
                apart = abs(other - when) if when is not None and other is not None else 0.0
                if gap <= MAX_TWIN_DISTANCE_M and apart <= MAX_TWIN_SECONDS and (best is None or (apart, gap) < best[0]):
                    best = ((apart, gap), pose)
            if best is None:
                continue
            pose = best[1]
            shift[i] = ((pose["lon"] - pose["gps_lon"]) * per_lon, (pose["lat"] - pose["gps_lat"]) * per_lat)
            turn[i] = (pose["yaw"] - pose["gps_yaw"] + 180) % 360 - 180
            found[i] = True
        twins = int(found.sum())
        if twins < MIN_TWINS:
            self.align_reason = (f"only {twins} of these {n} photos have a twin there (a photo of the same "
                                 "shot, by the number in its name, taken at the same time and place)")
            return 0
        if twins < n:
            rank = self.rank.astype(float)
            order = np.argsort(rank[found])
            known = rank[found][order]
            for values in (shift[:, 0], shift[:, 1], turn):
                values[~found] = np.interp(rank[~found], known, values[found][order])
        self.xy = self.xy + shift
        self.yaw = self.yaw + turn
        self.aligned = True
        self.twin = found
        return twins

    def apply_camera_offset(self, right, down):
        """Moves every photo by a constant distance in its own picture (metres to the
        right and down of the picture, whose top points along the yaw)."""
        t = np.radians(self.yaw)
        c, s = np.cos(t), np.sin(t)
        east, south = c * right - s * down, s * right + c * down
        self.xy = self.xy + np.c_[east, -south]

    def neighbour_mask(self, radius=DEFAULT_NEIGHBOUR_RADIUS):
        """uint8 NxN mask: 1 where two images overlap enough on the ground to be worth matching."""
        dist = np.linalg.norm(self.xy[:, None] - self.xy[None], axis=2)
        mask = (dist < radius * self.short_side).astype(np.uint8)
        # Always keep consecutive shots so the match graph stays connected.
        a, b = np.array(self.order[:-1]), np.array(self.order[1:])
        mask[a, b] = mask[b, a] = 1
        np.fill_diagonal(mask, 0)
        return mask

    def image_to_pano(self, path, size):
        """3x3 similarity mapping pixels of an image of `size` (w, h) to panorama
        pixels: north up, one panorama pixel per image pixel."""
        i = self.index[path]
        w, h = size
        gsd = self.gsd * self.full_w / w
        t = math.radians(self.yaw[i])
        c, s = math.cos(t), math.sin(t)
        rot = np.array([[c, -s], [s, c]])  # image 'up' points along the gimbal yaw
        centre = np.array([self.xy[i, 0], -self.xy[i, 1]]) / gsd
        a = np.eye(3)
        a[:2, :2] = rot
        a[:2, 2] = centre - rot @ np.array([w / 2, h / 2])
        return a


# --------------------------------------------------------------------------- refinement


def collect_matches(features, matches, conf_thresh, max_matches_per_pair=60, min_matches=6):
    """Inlier point pairs of all confident image pairs: (P, Q, I, J) or None.
    The points of one pair are contiguous; max_matches_per_pair=None keeps all."""
    n = len(features)
    pts_i, pts_j, idx_i, idx_j = [], [], [], []
    for i in range(n):
        kp_i = features[i].getKeypoints()
        for j in range(i + 1, n):
            pm = matches[i * n + j]
            if pm.confidence < conf_thresh or len(pm.matches) == 0:
                continue
            inliers = np.asarray(pm.inliers_mask, bool)
            dm = [d for d, ok in zip(pm.getMatches(), inliers) if ok]
            if len(dm) < min_matches:
                continue
            if max_matches_per_pair is not None and len(dm) > max_matches_per_pair:
                dm = [dm[k] for k in np.linspace(0, len(dm) - 1, max_matches_per_pair).astype(int)]
            kp_j = features[j].getKeypoints()
            pts_i += [kp_i[d.queryIdx].pt for d in dm]
            pts_j += [kp_j[d.trainIdx].pt for d in dm]
            idx_i += [i] * len(dm)
            idx_j += [j] * len(dm)
    if not idx_i:
        return None
    return (np.array(pts_i, float), np.array(pts_j, float),
            np.array(idx_i, np.int64), np.array(idx_j, np.int64))


def _similarity_terms(points, img, sign):
    """COO pieces of x' and y' for p' = [[a, -b], [b, a]] p + t, with unknowns
    (a, b, tx, ty) at columns 4*img .. 4*img+3. Returns (cols, vals) for the
    x-rows and the y-rows, each shaped (len(img), 3)."""
    one = np.full(len(img), sign)
    base = 4 * img
    cols_x = np.c_[base, base + 1, base + 2]
    vals_x = np.c_[sign * points[:, 0], -sign * points[:, 1], one]
    cols_y = np.c_[base, base + 1, base + 3]
    vals_y = np.c_[sign * points[:, 1], sign * points[:, 0], one]
    return (cols_x, vals_x), (cols_y, vals_y)


class _CooSystem:
    """Sparse least-squares system A x ~ b stored as COO triplets."""

    def __init__(self, ncols):
        self.ncols = ncols
        self.nrows = 0
        self.r, self.c, self.v, self.b = [], [], [], []

    def add_rows(self, cols, vals, rhs):
        """cols/vals: (m, k) arrays (k entries per row), rhs: (m,)."""
        m, k = cols.shape
        self.r.append(np.repeat(np.arange(self.nrows, self.nrows + m), k))
        self.c.append(cols.ravel())
        self.v.append(vals.ravel())
        self.b.append(np.broadcast_to(np.asarray(rhs, float), (m,)))
        self.nrows += m

    def solve(self):
        """Least-squares solution via the normal equations A^T A x = A^T b.

        A^T A is only (4n+1)^2, so this needs a few MB where a dense A needs
        hundreds. Columns are Jacobi-scaled before the solve to keep it well
        conditioned; falls back to lstsq if the system is singular."""
        r, c, v = (np.concatenate(x) for x in (self.r, self.c, self.v))
        b = np.concatenate(self.b)
        order = np.argsort(r, kind="stable")
        r, c, v = r[order], c[order], v[order]
        nc = self.ncols
        ata = np.zeros(nc * nc)
        # Entries of one row are contiguous after sorting; pair each entry with the
        # entries d places later in the same row (d = 0 gives the squares).
        max_nnz = int(np.bincount(r).max())
        for d in range(max_nnz):
            same = r[: len(r) - d] == r[d:]
            ci, cj = c[: len(c) - d][same], c[d:][same]
            prod = v[: len(v) - d][same] * v[d:][same]
            ata += np.bincount(ci * nc + cj, prod, nc * nc)
            if d:
                ata += np.bincount(cj * nc + ci, prod, nc * nc)
        ata = ata.reshape(nc, nc)
        atb = np.bincount(c, v * b[r], nc)

        diag = np.sqrt(np.abs(np.diag(ata)))
        scale = np.where(diag > 0, 1.0 / np.where(diag > 0, diag, 1.0), 1.0)
        m = ata * scale[:, None] * scale[None, :]
        rhs = atb * scale
        try:
            y = np.linalg.solve(m, rhs)
            if not np.all(np.isfinite(y)):
                raise np.linalg.LinAlgError("non-finite solution")
        except np.linalg.LinAlgError:
            y = np.linalg.lstsq(m, rhs, rcond=None)[0]
        return y * scale


def keystone(points, centres, tilt):
    """Picture points as a camera looking straight down would have seen them.

    A camera tilted a little off straight down sees flat ground through a keystone:
    what shows at d from the picture centre belongs at d / (1 + tilt . d). `tilt` is
    minus the tilt angle towards the right and the bottom of the picture (radians),
    divided by the focal length in pixels: the ground on the side the camera leans to
    is further away and shows smaller, so it is spread out. `centres` holds the
    picture centre of every point. First order in the tilt: good to a few centimetres
    for the 1-2 degrees of a drone gimbal (see MAX_TILT_DEG).
    """
    d = points - centres
    return centres + d / (1 + d @ tilt)[:, None]


# The tilt is not linear in the matches; this many linearised solves settle it.
TILT_ROUNDS = 3
# How closely a picture centre is held to its GPS position, in pixels of the solve.
DEFAULT_GPS_SIGMA_PX = 15.0


def solve_similarities(initial, sizes, P, Q, I, J, gps_sigma_px=DEFAULT_GPS_SIGMA_PX, scale_sigma=0.004,
                       yaw_sigma=0.04, offset_sigma_px=None, tilt_sigma=None):
    """Least-squares fit of per-image similarities (image -> panorama) to the
    point matches, softly anchored to the GPS layout (gps_sigma_px: one sigma, or
    one per image). Returns (x (n, 4), k, offset, tilt).

    Two things about the camera, the same in every picture, can be solved along:

    offset_sigma_px: the anchors may all be off by one constant (right, down) distance
    in the picture, `offset`: the picture centres then belong at their anchor +
    Rot(yaw) offset. Held near zero with this sigma (it cannot be told from a shift
    of everything when all pictures point the same way).

    tilt_sigma: the camera may look a little off straight down, `tilt` (see
    keystone), held near zero with this sigma. The similarities then fit the matched
    points after keystone(points, centres, tilt), and the pictures have to be
    straightened the same way before they are put together.
    """
    n = len(initial)
    x0 = np.array([[m[0, 0], m[1, 0], m[0, 2], m[1, 2]] for m in initial])
    centres = np.array([[w / 2, h / 2] for w, h in sizes], float)
    rn = np.arange(n)
    gps_sigma = np.broadcast_to(np.asarray(gps_sigma_px, float), (n,))
    k_col = 4 * n
    ncols = k_col + 1  # (a, b, tx, ty) per image, then one shared scale k
    offset_col = tilt_col = None
    if offset_sigma_px:
        offset_col, ncols = ncols, ncols + 2
    if tilt_sigma:
        tilt_col, ncols = ncols, ncols + 2
    cos, sin = x0[:, 0], x0[:, 1]

    def straightened(tilt):
        if not tilt_sigma:
            return P, Q
        return keystone(P, centres[I], tilt), keystone(Q, centres[J], tilt)

    def residuals(x, tilt):
        def apply(points, img):
            a, b, tx, ty = x[img].T
            return np.c_[a * points[:, 0] - b * points[:, 1] + tx,
                         b * points[:, 0] + a * points[:, 1] + ty]
        p, q = straightened(tilt)
        return np.linalg.norm(apply(p, I) - apply(q, J), axis=1)

    def solve(weights, x_now, tilt):
        """One linear solve; with a tilt, linearised around `tilt` and the turn and
        scale the pictures have in `x_now`."""
        sys_ = _CooSystem(ncols)
        keep = weights != 0
        w = weights[keep]
        i, j = I[keep], J[keep]
        p, q = (points[keep] for points in straightened(tilt))
        (cxi, vxi), (cyi, vyi) = _similarity_terms(p, i, 1.0)
        (cxj, vxj), (cyj, vyj) = _similarity_terms(q, j, -1.0)
        cols_x, vals_x = np.c_[cxi, cxj], np.c_[vxi, vxj]
        cols_y, vals_y = np.c_[cyi, cyj], np.c_[vyi, vyj]
        if tilt_sigma:
            # A change of the tilt moves a straightened point by -d (d . change) / s^2,
            # and the picture's turn and scale carry that into the panorama.
            def moved(points, img):
                d = points - centres[img]
                scale = (1 + d @ tilt) ** 2
                a, b = x_now[img, 0], x_now[img, 1]
                in_pano = np.c_[a * d[:, 0] - b * d[:, 1], b * d[:, 0] + a * d[:, 1]] / scale[:, None]
                return -in_pano[:, :1] * d, -in_pano[:, 1:] * d  # x rows, y rows: (m, 2) each

            (pxm, pym), (qxm, qym) = moved(P[keep], i), moved(Q[keep], j)
            tilt_cols = np.tile([tilt_col, tilt_col + 1], (len(i), 1))
            cols_x, vals_x = np.c_[cols_x, tilt_cols], np.c_[vals_x, pxm - qxm]
            cols_y, vals_y = np.c_[cols_y, tilt_cols], np.c_[vals_y, pym - qym]
            for col, value in zip((tilt_col, tilt_col + 1), tilt):
                # the unknown is the change of the tilt; the prior holds the tilt itself
                sys_.add_rows(np.array([[col]]), np.array([[1.0 / tilt_sigma]]), -value / tilt_sigma)
        sys_.add_rows(cols_x, vals_x * w[:, None], 0.0)
        sys_.add_rows(cols_y, vals_y * w[:, None], 0.0)

        # GPS prior on where each image centre lands
        (gcx, gvx), (gcy, gvy) = _similarity_terms(centres, rn, 1.0)
        target = np.c_[x0[:, 0] * centres[:, 0] - x0[:, 1] * centres[:, 1] + x0[:, 2],
                       x0[:, 1] * centres[:, 0] + x0[:, 0] * centres[:, 1] + x0[:, 3]]
        if offset_sigma_px:
            ox, oy = np.full(n, offset_col), np.full(n, offset_col + 1)
            gcx, gvx = np.c_[gcx, ox, oy], np.c_[gvx, -cos, sin]
            gcy, gvy = np.c_[gcy, ox, oy], np.c_[gvy, -sin, -cos]
            for col in (offset_col, offset_col + 1):
                sys_.add_rows(np.array([[col]]), np.array([[1.0 / offset_sigma_px]]), 0.0)
        sys_.add_rows(gcx, gvx / gps_sigma[:, None], target[:, 0] / gps_sigma)
        sys_.add_rows(gcy, gvy / gps_sigma[:, None], target[:, 1] / gps_sigma)

        # pose prior: (a, b) ~ k * (cos, sin) of the gimbal yaw. Along (cos, sin) that
        # is a tight prior for constant flight altitude (one shared scale k for all
        # images); across it a looser one for the rotation, because in turns the
        # gimbal yaw can be a few degrees off and the matches should win there.
        sys_.add_rows(np.c_[4 * rn, 4 * rn + 1, np.full(n, k_col)],
                      np.c_[cos, sin, -np.ones(n)] / scale_sigma, 0.0)
        sys_.add_rows(np.c_[4 * rn, 4 * rn + 1], np.c_[-sin, cos] / yaw_sigma, 0.0)

        sol = sys_.solve()
        offset = sol[offset_col:offset_col + 2] if offset_sigma_px else np.zeros(2)
        if tilt_sigma:
            tilt = tilt + sol[tilt_col:tilt_col + 2]
        return sol[:k_col].reshape(n, 4), float(sol[k_col]), offset, tilt

    def settle(weights, x, tilt):
        for _ in range(TILT_ROUNDS if tilt_sigma else 1):
            x, k, offset, tilt = solve(weights, x, tilt)
        return x, k, offset, tilt

    x, _, _, tilt = settle(np.ones(len(I)), x0, np.zeros(2))
    # one robust pass: drop matches far off the consensus, then re-solve
    r = residuals(x, tilt)
    keep = (r < max(3.0, 3 * np.median(r))).astype(float)
    return settle(keep, x, tilt)


def refine_similarities(initial, sizes, features, matches, conf_thresh,
                        gps_sigma_px=DEFAULT_GPS_SIGMA_PX, max_matches_per_pair=60, **priors):
    """Refine per-image similarity transforms (image -> panorama) with feature
    matches, softly anchored to the GPS positions so long strips cannot bend.

    Each transform is p' = [[a, -b], [b, a]] p + t, which is linear in (a, b, tx, ty),
    so the whole problem is one small sparse linear least-squares solve.
    Returns (transforms, k, pts, offset, tilt): k = true image pixel size / assumed
    one (biased low in turns, so only a sanity check), pts = the matches used, with
    their points straightened by the tilt (None if none), offset and tilt = what
    solve_similarities found out about the camera (offset in pixels of `initial`).
    `priors` are passed on to solve_similarities.
    """
    pts = collect_matches(features, matches, conf_thresh, max_matches_per_pair)
    if pts is None:
        return list(initial), 1.0, None, np.zeros(2), np.zeros(2)
    x, scale, offset, tilt = solve_similarities(initial, sizes, *pts, gps_sigma_px=gps_sigma_px, **priors)
    # GPS fixes the overall scale; rescale so one panorama pixel == one image pixel
    # (keeps the user's GSD valid). `scale` = true image pixel size / assumed one.
    refined = [np.array([[a, -b, tx], [b, a, ty], [0, 0, 1]]) for a, b, tx, ty in x / scale]
    if tilt.any():
        P, Q, I, J = pts
        centres = np.array([[w / 2, h / 2] for w, h in sizes], float)
        pts = (keystone(P, centres[I], tilt), keystone(Q, centres[J], tilt), I, J)
    return refined, scale, pts, offset, tilt


def match_misfit(transforms, sizes, pts):
    """Median distance (panorama px) between matched points once every image is
    placed with its unit-scale transform (unit_similarity), as it will be warped."""
    P, Q, I, J = pts
    units = np.array([unit_similarity(a, size) for a, size in zip(transforms, sizes)])

    def apply(points, img):
        return np.einsum("nij,nj->ni", units[img, :2, :2], points) + units[img, :2, 2]

    return float(np.median(np.linalg.norm(apply(P, I) - apply(Q, J), axis=1)))


def linked_images(matches, n, conf_thresh, min_matches=6):
    """Indices of the images that have at least one pair collect_matches would use."""
    linked = set()
    for i in range(n):
        for j in range(i + 1, n):
            pm = matches[i * n + j]
            if pm.confidence >= conf_thresh and int(np.count_nonzero(pm.inliers_mask)) >= min_matches:
                linked.update((i, j))
    return sorted(linked)


def pair_scale_ratios(initial, sizes, P, Q, I, J, min_baseline_px=50.0):
    """Per image pair: GPS baseline / baseline implied by the matches, i.e. the true
    image pixel size / the assumed one (`initial` = GPS layout transforms).

    Each pair's relative rotation is fitted from its own matches, so a gimbal yaw
    that does not match the real heading (common in turns) cannot bias the ratio.
    Pairs whose baseline is not well above GPS noise are skipped."""
    def centre(a, size):
        return a[:2, :2] @ (np.array(size, float) / 2) + a[:2, 2]

    if len(I) == 0:
        return []
    starts = np.flatnonzero(np.r_[True, (I[1:] != I[:-1]) | (J[1:] != J[:-1])])
    ratios = []
    for lo, hi in zip(starts, np.r_[starts[1:], len(I)]):
        i, j = I[lo], J[lo]
        baseline = np.linalg.norm(centre(initial[j], sizes[j]) - centre(initial[i], sizes[i]))
        if baseline < min_baseline_px:
            continue
        # points as complex numbers relative to their image centre
        p = (P[lo:hi] - np.array(sizes[i], float) / 2) @ np.array([1, 1j])
        q = (Q[lo:hi] - np.array(sizes[j], float) / 2) @ np.array([1, 1j])
        rot = np.sum(np.conj(q - q.mean()) * (p - p.mean()))
        if rot == 0:
            continue
        # p ~ rot * q + d, where d is image j's centre in image i's pixels
        offset = abs(p.mean() - rot / abs(rot) * q.mean())
        if offset > 0:
            ratios.append(baseline / offset)
    return ratios


def robust_scale(ratios, min_pairs=5, max_spread=0.1):
    """Median of the per-pair ratios, or None when there are too few or they disagree."""
    if len(ratios) < min_pairs:
        return None
    q1, mid, q3 = np.percentile(ratios, [25, 50, 75])
    if not (math.isfinite(mid) and mid > 0) or (q3 - q1) / mid > max_spread:
        return None
    return float(mid)


def gps_scale(initial, sizes, pts, rank, straight):
    """True image pixel size / assumed one from collect_matches output, or None.

    rank: capture-order position per image; straight: False for shots in a turn."""
    if pts is None:
        return None
    P, Q, I, J = pts
    # Only consecutive shots on a straight line: they are seconds apart, so their
    # GPS errors mostly cancel in the baseline (shots from neighbouring strips are
    # minutes apart), and in turns the baselines are biased by up to 10%.
    use = (np.abs(rank[J] - rank[I]) == 1) & straight[I] & straight[J]
    return robust_scale(pair_scale_ratios(initial, sizes, P[use], Q[use], I[use], J[use]))


def unit_similarity(image_to_pano, size):
    """The similarity reduced to a pure rotation about the image centre (unit
    scale), keeping the image centre where the similarity puts it."""
    w, h = size
    centre = np.array([w / 2, h / 2])
    lin = image_to_pano[:2, :2]
    rot = lin / math.hypot(lin[0, 0], lin[1, 0])
    unit = np.eye(3)
    unit[:2, :2] = rot
    unit[:2, 2] = lin @ centre + image_to_pano[:2, 2] - rot @ centre
    return unit


def fit_north_up(pixels, ground, fallback_scale, min_spread=20.0):
    """(scale, east0, north0) of the north-up map east = east0 + scale * col,
    north = north0 - scale * row, fitted by least squares to image centres in the
    panorama (pixels) and on the ground (metres). One pass drops images far off the
    consensus (GPS spikes). Images closer together than min_spread metres (RMS) say
    nothing reliable about scale, so fallback_scale is used for those."""

    def solve(keep):
        p, g = pixels[keep], ground[keep]
        p_mean, g_mean = p.mean(axis=0), g.mean(axis=0)
        dp, dg = p - p_mean, g - g_mean
        denom = float((dp ** 2).sum())
        scale = fallback_scale
        if denom > 0 and math.sqrt(float((dg ** 2).sum()) / len(g)) >= min_spread:
            fitted = float((dp[:, 0] * dg[:, 0] - dp[:, 1] * dg[:, 1]).sum()) / denom
            if math.isfinite(fitted) and fitted > 0:
                scale = fitted
        return scale, g_mean[0] - scale * p_mean[0], g_mean[1] + scale * p_mean[1]

    everything = np.ones(len(pixels), bool)
    scale, east0, north0 = solve(everything)
    off = np.hypot(east0 + scale * pixels[:, 0] - ground[:, 0], north0 - scale * pixels[:, 1] - ground[:, 1])
    keep = off <= max(2.0, 3 * float(np.median(off)))
    return solve(keep) if keep.sum() >= 2 else (scale, east0, north0)


def affine_camera(image_to_pano, size):
    """cv2.detail.CameraParams equivalent to what AffineBasedEstimator produces
    (focal 1, principal point 0, aspect 1, t 0) for an image -> panorama similarity.

    stitching's affine cameras hold the panorama -> image transform, hence the
    inverse. OpenCV's plane projector inverts R by transposing it, so only an
    orthonormal linear part warps consistently (warpRoi and the pixel remap
    agree); the similarity is therefore reduced to unit_similarity.
    """
    unit = unit_similarity(image_to_pano, size)
    cam = cv2.detail.CameraParams()
    cam.focal = 1.0
    cam.ppx = 0.0
    cam.ppy = 0.0
    cam.aspect = 1.0
    cam.t = np.zeros((3, 1), np.float64)
    cam.R = np.linalg.inv(unit).astype(np.float32)
    return cam


# --------------------------------------------------------------------------- stitcher


class GpsStitcher(AffineStitcher):
    """Flat-ground stitcher for nadir drone surveys.

    Uses GPS to (1) only match images that actually overlap and (2) seed each
    image's position/rotation, so the solve only refines instead of chaining
    100+ pairwise estimates (which drifts and bends long strips).
    """

    def __init__(self, layout=None, neighbour_radius=DEFAULT_NEIGHBOUR_RADIUS, **kwargs):
        self.layout = layout if layout is not None and layout.valid else None
        self.neighbour_radius = neighbour_radius
        self.use_gps_poses = self.layout is not None and self.layout.yaw is not None
        if self.use_gps_poses:
            # poses come from GPS + our own refinement; OpenCV's bundle adjuster
            # would re-introduce the chained drift (and is the slowest step)
            kwargs.setdefault("adjuster", "no")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", StitchingWarning)
            super().__init__(**kwargs)
        self.confidence_threshold = self.settings["confidence_threshold"]
        # the GPS refinement requires solid pairs; the repetitive crop rows produce
        # weak false matches
        self.refine_confidence = max(1.0, self.confidence_threshold)
        self.estimated_gsd = None
        self.gps_aligned = False
        self.cameras = None
        self.panorama_mask = None
        self.final_corners = None
        self.final_sizes = None
        self.tilt = None  # (tilt of solve_similarities, width of the images it is in pixels of)
        # an aligned layout (align_to) was refined with the camera offset as planned; when
        # False the photos sit at their twins, but may be a few metres off
        self.align_refined = False

    # progress reporting wrappers --------------------------------------------

    def resized(self, resolution):
        """The photos at `resolution`, like Images.resize, but shrunk by averaging pixel
        areas: stitching's linear interpolation aliases fine texture such as grass when a
        12 MP wide photo is shrunk 4-5 times for matching, and the aliased photos of a
        plain field hardly match each other (most were left out). Photos that are not
        shrunk (the thermal ones) come out exactly as before."""
        images = self.images
        scaler = images._get_scaler(resolution)  # its scale is set while the first photo is read
        for img in images:
            h, w = img.shape[:2]
            want = scaler.get_scaled_img_size((w, h))
            shrink = want[0] < w or want[1] < h
            yield cv2.resize(img, want, interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR_EXACT)

    def resize_medium_resolution(self):
        log(f"Loading {len(self.images.names)} images")
        return list(self.resized(Images.Resolution.MEDIUM))

    def find_features(self, imgs, feature_masks=[]):
        log(f"Finding features in {len(imgs)} images")
        return super().find_features(imgs, feature_masks)

    def match_features(self, features):
        n = len(features)
        total = n * (n - 1) // 2
        if self.layout is None:
            log(f"Matching all {total} image pairs")
            return super().match_features(features)
        mask = self.layout.neighbour_mask(self.neighbour_radius)
        log(f"Matching {int(mask.sum()) // 2} of {total} image pairs (GPS neighbours)")
        return self.matcher.match_features(features, mask)

    def subset(self, imgs, features, matches):
        names = list(self.images.names)
        imgs, features, matches = super().subset(imgs, features, matches)
        kept = set(self.images.names)
        dropped = [p for p in names if p not in kept]
        if dropped:
            log(f"Left out {len(dropped)} of {len(names)} images that did not match the others "
                f"(e.g. {example(dropped)})")
        if self.use_gps_poses:
            # An image without one solid pair would be placed from GPS + gimbal yaw
            # only, which is metres off in turns; leave it out rather than blend it in.
            # (With no solid pair at all, everything is placed from GPS; see below.)
            n = len(features)
            linked = linked_images(matches, n, self.refine_confidence)
            if 2 <= len(linked) < n:
                keep = set(linked)
                unlinked = [p for k, p in enumerate(self.images.names) if k not in keep]
                imgs = Subsetter.subset_list(imgs, linked)
                features = Subsetter.subset_list(features, linked)
                matches = Subsetter.subset_matches(matches, linked)
                self.images.subset(linked)
                log(f"Left out {len(unlinked)} of {n} images with no reliable match to the others "
                    f"(e.g. {example(unlinked)})")
        return imgs, features, matches

    def estimate_camera_parameters(self, features, matches):
        if not self.use_gps_poses:
            log("Estimating image positions from feature matches")
            return super().estimate_camera_parameters(features, matches)
        log("Estimating image positions from GPS and feature matches")
        sizes = self.images.get_scaled_img_sizes(Images.Resolution.MEDIUM)
        names = self.images.names
        initial = [self.layout.image_to_pano(name, size) for name, size in zip(names, sizes)]
        conf_thresh = self.refine_confidence
        priors = {}
        metres = self.layout.gsd * self.layout.full_w / sizes[0][0]  # per pixel of `initial`
        tilt_sigma = TILT_SIGMA * metres / self.layout.altitude
        aligned = self.layout.aligned
        offset_known = False
        if aligned:
            # the positions come from the other panorama: hold on to them tightly, and
            # find out how the camera looks at the ground compared with the other one
            idx = [self.layout.index[name] for name in names]
            twin = self.layout.twin[idx]
            priors = dict(gps_sigma_px=np.where(twin, ALIGN_SIGMA_M / metres, DEFAULT_GPS_SIGMA_PX),
                          yaw_sigma=ALIGN_YAW_SIGMA, tilt_sigma=tilt_sigma)
            # the camera offset turns with the photos; only photos that face different
            # ways tell it from a shift of the whole mosaic
            t = np.radians(self.layout.yaw[idx])
            offset_known = math.hypot(np.cos(t).mean(), np.sin(t).mean()) <= MAX_HEADING_CONCENTRATION
            if offset_known:
                priors["offset_sigma_px"] = ALIGN_OFFSET_SIGMA_M / metres
        solved = refine_similarities(initial, sizes, features, matches, conf_thresh, **priors)
        problem = self.refinement_problem(solved, sizes, metres)
        if problem and solved[2] is not None and "tilt_sigma" not in priors:
            # A camera that looks a little off straight down bends wide photos at their
            # edges by more than the matches allow there; allow for that before giving up.
            retry = refine_similarities(initial, sizes, features, matches, conf_thresh, tilt_sigma=tilt_sigma,
                                        **priors)
            if self.refinement_problem(retry, sizes, metres) is None:
                solved, problem = retry, None
        refined, scale, pts, offset, tilt = solved
        refined_ok = problem is None
        if problem:
            # where the photos go when the refinement cannot be used
            fallback = ("they are placed where their twins are in the other panorama, without allowing for "
                        "the distance between the two cameras, so the two may be a few metres apart" if aligned
                        else "positions come from GPS only, so seams may be misaligned")
            log(f"Warning: {problem}; {fallback}")
            refined = initial
            offset = tilt = np.zeros(2)
        if aligned:
            right, down = (float(v) * metres for v in offset)
            if right or down:
                log(f"The two cameras look {math.hypot(right, down):.1f} m apart on the ground; allowed for")
            elif refined_ok and not offset_known:
                log("Warning: the photos all face about the same way, so the distance between the two "
                    "cameras cannot be measured; the two panoramas may be a few metres apart")
            # so that the map is fitted to where the pictures belong, not to their anchors
            self.layout.apply_camera_offset(right, down)
            fits = True
            if refined_ok:
                # The matches turn the photos only a little away from their twins, unless the
                # other panorama does not fit together (flight lines stitched apart there).
                turn = [math.atan2(r[1, 0], r[0, 0]) - math.atan2(a[1, 0], a[0, 0]) for r, a in zip(refined, initial)]
                turn = np.degrees(np.abs((np.array(turn) + math.pi) % (2 * math.pi) - math.pi))[twin]
                fits = not len(turn) or float(np.median(turn)) <= MAX_TWIN_TURN_DEG
                if not fits:
                    log(f"Warning: the photos had to be turned {float(np.median(turn)):.1f} degrees (median) away "
                        "from their twins: the other panorama does not fit together everywhere, so the two may "
                        "be a metre or more apart in places")
            self.align_refined = refined_ok and offset_known and fits
        if tilt.any():
            degrees = math.degrees(float(np.hypot(*tilt)) * self.layout.altitude / metres)
            log(f"The camera looks {degrees:.1f} degrees off straight down; straightening the photos")
            self.tilt = (tilt, sizes[0][0])
        # ground size of one full-resolution pixel, measured against GPS baselines
        # (not the solver's shared scale k, see above); independent of the geometry
        idx = [self.layout.index[name] for name in names]
        ratio = gps_scale(initial, sizes,
                          collect_matches(features, matches, conf_thresh, max_matches_per_pair=None, min_matches=10),
                          self.layout.rank[idx], ~self.layout.turn[idx])
        if ratio is None:
            log("Warning: GPS scale is uncertain; enter the GSD manually")
        else:
            self.estimated_gsd = self.layout.gsd * ratio
        self.gps_aligned = True
        return [affine_camera(a, size) for a, size in zip(refined, sizes)]

    def refinement_problem(self, solved, sizes, metres):
        """Why the result of refine_similarities cannot be used, or None."""
        refined, scale, pts, _, tilt = solved
        if pts is None:
            return "no strong matches between images"
        # k itself is no validity signal (it comes out 25-45% low in turns, with
        # fine geometry); judge the refinement by how well the matches line up.
        misfit = match_misfit(refined, sizes, pts) if math.isfinite(scale) and 0.2 <= scale <= 5.0 else math.inf
        if not misfit <= 3.0:
            return f"the feature matches do not fit together (median misfit {misfit:.1f} px)"
        degrees = math.degrees(float(np.hypot(*tilt)) * self.layout.altitude / metres)
        if degrees > MAX_TILT_DEG:
            return f"the photos would need a camera looking {degrees:.0f} degrees off straight down, which is not likely"
        return None

    def refine_camera_parameters(self, features, matches, cameras):
        if self.settings["adjuster"] != "no":
            log("Adjusting image positions")
        return super().refine_camera_parameters(features, matches, cameras)

    def estimate_scale(self, cameras):
        self.cameras = list(cameras)
        super().estimate_scale(cameras)

    def straightening(self, w, h):
        """Homography taking a w x h photo to how a camera looking straight down would
        have taken it (see keystone): p -> centre + d / (1 + tilt . d), d = p - centre."""
        tilt, width = self.tilt
        gx, gy = tilt * (width / w)  # per pixel of this size of the image
        cx, cy = w / 2, h / 2
        to_centre = np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1]], float)
        bend = np.array([[1, 0, 0], [0, 1, 0], [gx, gy, 1]], float)
        back = np.array([[1, 0, cx], [0, 1, cy], [0, 0, 1]], float)
        return back @ bend @ to_centre

    def straightened(self, img):
        """`img` as a camera looking straight down would have taken it. Along the side
        the camera looks away from, a strip of the frame has no picture; it is filled
        with the edge pixels and left out by straightened_mask."""
        if self.tilt is None:
            return img
        h, w = img.shape[:2]
        return cv2.warpPerspective(img, self.straightening(w, h), (w, h), flags=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_REPLICATE)

    def straightened_mask(self, size):
        """255 where a straightened photo of `size` (w, h) shows picture, 0 in the strip
        that only holds repeated edge pixels."""
        w, h = size
        mask = np.full((h, w), 255, np.uint8)
        if self.tilt is None:
            return mask
        return cv2.warpPerspective(mask, self.straightening(w, h), (w, h), flags=cv2.INTER_NEAREST,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=0)

    def warp(self, imgs, cameras, sizes, aspect=1):
        if self.tilt is None:
            return super().warp(imgs, cameras, sizes, aspect)
        # stitching.Stitcher.warp, with the photos' own masks instead of full rectangles
        imgs = self.warper.warp_images(imgs, cameras, aspect)
        masks = (self.warped_mask(self.straightened_mask(size), camera, aspect)
                 for size, camera in zip(sizes, cameras))
        corners, sizes = self.warper.warp_rois(sizes, cameras, aspect)
        return imgs, masks, corners, sizes

    def warped_mask(self, mask, camera, aspect):
        """Warper.create_and_warp_mask for a given mask."""
        warper = cv2.PyRotationWarper(self.warper.warper_type, self.warper.scale * aspect)
        _, warped = warper.warp(mask, Warper.get_K(camera, aspect), camera.R, cv2.INTER_NEAREST,
                                cv2.BORDER_CONSTANT)
        return warped

    def resize_low_resolution(self, imgs=None):
        return [self.straightened(img) for img in super().resize_low_resolution(imgs)]

    def resize_final_resolution(self):
        return (self.straightened(img) for img in self.resized(Images.Resolution.FINAL))

    def find_seam_masks(self, imgs, corners, masks):
        log("Finding seams between images")
        return super().find_seam_masks(imgs, corners, masks)

    def initialize_composition(self, corners, sizes):
        self.final_corners = list(corners)
        self.final_sizes = list(sizes)
        super().initialize_composition(corners, sizes)

    def blend_images(self, imgs, masks, corners):
        n = len(self.images.names)
        step = max(1, n // 10)

        def counted():
            for idx, img in enumerate(imgs):
                if idx % step == 0 or idx == n - 1:
                    log(f"Warping and blending image {idx + 1} of {n}")
                yield img

        super().blend_images(counted(), masks, corners)

    def create_final_panorama(self):
        log("Finishing the blend")
        panorama, mask = self.blender.blend()  # keep the coverage mask (stitching drops it)
        if isinstance(panorama, cv2.UMat):
            panorama = panorama.get()
        if isinstance(mask, cv2.UMat):
            mask = mask.get()
        self.panorama_mask = mask
        return panorama

    # results ------------------------------------------------------------------

    def pano_scale(self):
        """Panorama pixels per full-resolution source-image pixel (median over images).

        For stitching's affine warper the pixel content of an image lands at
        inv(R) (scaled by warper.scale / focal), independent of the MEDIUM->FINAL
        camera aspect, so the linear scale of image i in the panorama is
        warper.scale / focal_i / sqrt(|det R_i|) per FINAL-resolution pixel.
        """
        if not self.cameras:
            return None
        per_image = [
            self.warper.scale / cam.focal / math.sqrt(abs(float(np.linalg.det(cam.R[:2, :2].astype(float)))))
            for cam in self.cameras
        ]
        full_w = self.images.sizes[0][0]
        final_w = self.images.get_scaled_img_sizes(Images.Resolution.FINAL)[0][0]
        return float(median(per_image)) * final_w / full_w

    def image_centres(self):
        """Centre of every included image in panorama pixels (pixel-edge coordinates).
        The warp only rotates, so the centre of the warped bounding box is the image centre."""
        corners = np.array(self.final_corners, float)
        sizes = np.array(self.final_sizes, float)
        return corners - corners.min(axis=0) + sizes / 2

    def image_yaws(self):
        """Compass direction (degrees) of the top edge of every included image, as placed."""
        yaws = []
        for cam in self.cameras:
            rot = np.linalg.inv(np.asarray(cam.R, float))[:2, :2]  # image -> panorama
            yaws.append(math.degrees(math.atan2(rot[1, 0], rot[0, 0])))
        return yaws

    def poses(self, geotransform):
        """Where every included image ended up, next to what its own tags say.

        Per image: "lon"/"lat" of its centre on the panorama's map and "yaw" of its top
        edge as placed, and "gps_lon"/"gps_lat"/"gps_yaw" as tagged. The differences are
        what the matches corrected; a second set of photos from the same flight can be
        placed with them (see GpsLayout.align_to). None without map coordinates.
        """
        if geotransform is None or self.layout is None or self.layout.yaw is None or not self.cameras:
            return None
        lon0, dlon, _, lat0, _, dlat = geotransform
        layout = self.layout
        out = []
        for name, (col, row), yaw in zip(self.images.names, self.image_centres(), self.image_yaws()):
            i = layout.index[name]
            out.append({
                "image": name,
                "lon": lon0 + dlon * float(col), "lat": lat0 + dlat * float(row), "yaw": yaw,
                "gps_lon": float(layout.lonlat[i, 0]), "gps_lat": float(layout.lonlat[i, 1]),
                "gps_yaw": float(layout.tag_yaw[i]),
            })
        return out

    def geotransform(self, pano_scale):
        """GDAL-style [lon0, dlon, 0, lat0, 0, dlat] of the panorama, None without GPS poses."""
        if not self.gps_aligned or not self.final_corners:
            return None
        layout = self.layout
        idx = np.array([layout.index[name] for name in self.images.names])
        pixels, ground = self.image_centres(), layout.xy[idx]
        if layout.aligned:
            # only photos with a twin are tied to the other panorama; the others sit by
            # their own GPS, which may be off by a metre or two (another flight)
            keep = layout.twin[idx]
            enough = keep.sum() >= MIN_TWINS
        else:
            keep = ~layout.turn[idx]  # tagged positions are biased for shots taken in a turn
            enough = keep.sum() >= 3
        if enough:
            pixels, ground = pixels[keep], ground[keep]
        fallback = layout.gsd / pano_scale if pano_scale else layout.gsd
        scale, east0, north0 = fit_north_up(pixels, ground, fallback)
        (lon, lat), (per_lon, per_lat) = layout.origin, layout.metres_per_degree
        return [lon + east0 / per_lon, scale / per_lon, 0.0, lat + north0 / per_lat, 0.0, -scale / per_lat]


# --------------------------------------------------------------------------- I/O


def load_image_list(input_path):
    try:
        with open(input_path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise UserError(f"Image list not found: {input_path}") from None
    except (OSError, ValueError) as exc:
        raise UserError(f"Cannot read the image list {os.path.basename(input_path)}: {exc}") from None
    images = data.get("images") if isinstance(data, dict) else data
    if not isinstance(images, list) or not all(isinstance(p, str) for p in images):
        raise UserError('The image list must look like {"images": ["/path/a.jpg", ...]}')
    return images, data if isinstance(data, dict) else {}


def load_poses(result_path):
    """The "poses" of another panorama's result file; None when it has none (an older
    file, or a panorama without GPS) or cannot be used."""
    try:
        with open(result_path, encoding="utf-8") as f:
            poses = json.load(f).get("poses")
        keys = ("lon", "lat", "yaw", "gps_lon", "gps_lat", "gps_yaw")
        ok = isinstance(poses, list) and poses and all(
            isinstance(p["image"], str) and all(math.isfinite(float(p[k])) for k in keys) for p in poses)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None
    return poses if ok else None


def _atomic_temp(output_dir, suffix):
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=suffix, dir=output_dir)
    os.close(fd)
    umask = os.umask(0)
    os.umask(umask)
    os.chmod(tmp, 0o666 & ~umask)  # mkstemp creates 0600; use normal file permissions
    return tmp


def write_image_atomic(path, image, params=()):
    # cv2 picks the format by extension
    tmp = _atomic_temp(os.path.dirname(path), os.path.splitext(path)[1])
    try:
        ok = cv2.imwrite(tmp, image, list(params))
        if not ok or os.path.getsize(tmp) == 0:
            raise UserError(f"Could not save the panorama to {os.path.dirname(path)}")
        return tmp
    except BaseException:
        _remove(tmp)
        raise


def view_image(bgra, geotransform, frame):
    """`bgra` resampled onto the map frame of another panorama.

    `geotransform` places `bgra` on the map; `frame` holds the other panorama's
    "geotransform", "width" and "height". The result covers exactly that frame (so it can
    be drawn stretched over the other panorama), with at most the detail of `bgra` and at
    most VIEW_MAX_PIXELS pixels.
    """
    lon0, dlon, _, lat0, _, dlat = geotransform
    f_lon0, f_dlon, _, f_lat0, _, f_dlat = frame["geotransform"]
    frame_w, frame_h = int(frame["width"]), int(frame["height"])
    # the frame's edges in our pixels (both panoramas are north-up)
    x0 = (f_lon0 - lon0) / dlon
    y0 = (f_lat0 - lat0) / dlat
    x1 = x0 + frame_w * f_dlon / dlon
    y1 = y0 + frame_h * f_dlat / dlat
    if not (x1 - x0 >= 1 and y1 - y0 >= 1):
        raise UserError("The two panoramas do not fit on one map.")
    detail = min((x1 - x0) / frame_w, (y1 - y0) / frame_h)  # our pixels per frame pixel
    scale = min(detail, math.sqrt(VIEW_MAX_PIXELS / (frame_w * frame_h)),
                WEBP_MAX_SIDE / frame_w, WEBP_MAX_SIDE / frame_h)
    view_w, view_h = max(1, round(frame_w * scale)), max(1, round(frame_h * scale))

    # Whole pixels: off by at most half a pixel of ours, far below the GPS accuracy.
    x0, y0, x1, y1 = round(x0), round(y0), round(x1), round(y1)
    h, w = bgra.shape[:2]
    if x0 >= 0 and y0 >= 0 and x1 <= w and y1 <= h:
        crop = bgra[y0:y1, x0:x1]
    else:  # the frame sticks out of our panorama: nothing to show there
        crop = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        cx0, cy0, cx1, cy1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
        if cx1 > cx0 and cy1 > cy0:
            crop[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0] = bgra[cy0:cy1, cx0:cx1]
    shrinking = view_w < crop.shape[1]
    view = cv2.resize(crop, (view_w, view_h), interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR)

    # Empty pixels are black, so the colours along the edge were averaged with black:
    # undo that and make every pixel either part of the picture or not.
    alpha = view[..., 3]
    edge = (alpha > 0) & (alpha < 255)
    if edge.any():
        colours = view[edge, :3].astype(np.float32) * (255.0 / alpha[edge, None])
        view[edge, :3] = np.clip(colours, 0, 255).astype(np.uint8)
    solid = alpha >= 128
    view[~solid] = 0
    alpha[solid] = 255
    return view


def write_json_temp(path, data):
    tmp = _atomic_temp(os.path.dirname(path), ".json")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        return tmp
    except BaseException:
        _remove(tmp)
        raise


def _positive_or_none(value):
    """A finite, strictly positive number (rounded) or None; NaN would make invalid JSON."""
    if value is None:
        return None
    value = float(value)
    return round(value, 6) if math.isfinite(value) and value > 0 else None


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def final_megapix(size, layout, target_gsd):
    """Megapixels per photo for the final blend, or -1 for full resolution."""
    megapix = size[0] * size[1] / 1e6
    if target_gsd and layout.valid:
        scale = layout.gsd / target_gsd  # from the altitude: a first guess, good to about 10%
    else:
        scale = math.sqrt(DEFAULT_MAX_MEGAPIX / megapix)
    return -1 if scale >= 1 else megapix * scale * scale


def run(input_path, output_dir, panorama_name=PANORAMA_NAME, result_name=RESULT_NAME):
    started = time.perf_counter()
    radius = neighbour_radius()
    output_dir = os.path.abspath(output_dir)
    images, options = load_image_list(input_path)
    target_gsd, view, align_to = (options.get(key) for key in ("target_gsd", "view", "align_to"))
    paths = list(dict.fromkeys(images))  # drop duplicates, keep order
    if len(paths) < 2:
        raise UserError("Select at least two images to stitch.")
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as exc:
        raise UserError(f"Cannot create the output folder {output_dir}: {exc.strerror or exc}") from None
    if not os.access(output_dir, os.W_OK):
        raise UserError(f"Cannot save to the output folder {output_dir}: it is not writable.")

    log(f"Reading metadata of {len(paths)} images")
    infos = [inspect_image(p) for p in paths]
    size = check_same_size(infos)

    layout = GpsLayout(infos, size)
    if not layout.valid:
        log(f"Not using GPS: {layout.reason}; matching every pair instead (slower, scale less reliable)")
    elif layout.yaw is None:
        log(f"GPS used for matching only: {layout.yaw_reason}")
    for message in layout.warnings:
        log(f"Warning: {message}")
    if align_to:
        twins = layout.align_to(load_poses(align_to))
        if twins:
            log(f"Lining the photos up with the other panorama ({twins} shots in common)")
        else:
            placed = ("placing them by their own GPS, which can be a few metres off"
                      if layout.valid and layout.yaw is not None else "they cannot be put on the map")
            log(f"Warning: these photos cannot be lined up with the other panorama ({layout.align_reason}); {placed}")

    final = final_megapix(size, layout, target_gsd)
    if final > 0:
        log(f"Blending the photos at {final:.1f} of {size[0] * size[1] / 1e6:.1f} megapixels")
    stitcher = GpsStitcher(layout=layout, neighbour_radius=radius, final_megapix=final,
                           detector="sift", confidence_threshold=0.2, crop=False)
    panorama = stitcher.stitch(paths)
    if panorama is None or stitcher.panorama_mask is None:
        raise UserError("Stitching produced no panorama.")

    mask = stitcher.panorama_mask
    if mask.ndim == 3:
        mask = mask[..., 0]
    alpha = np.where(mask > 0, 255, 0).astype(np.uint8)
    if panorama.ndim == 2:
        panorama = cv2.cvtColor(panorama, cv2.COLOR_GRAY2BGR)
    bgra = np.dstack([panorama[..., :3], alpha])
    bgra[alpha == 0, :3] = 0
    h, w = bgra.shape[:2]

    included = list(stitcher.images.names)
    pano_scale = stitcher.pano_scale()
    estimated_gsd = stitcher.estimated_gsd if stitcher.gps_aligned else None

    geotransform = stitcher.geotransform(pano_scale)
    view_path = view_result = view_pixels = None
    if view and geotransform:
        log("Preparing the view")
        view_pixels = view_image(bgra, geotransform, view)
        view_path = os.path.join(output_dir, os.path.basename(view["name"]))
        view_result = {
            "path": view_path,
            "width": int(view_pixels.shape[1]),
            "height": int(view_pixels.shape[0]),
            "frame": {key: view[key] for key in ("geotransform", "width", "height")},
        }
    elif view:
        log("Warning: without GPS positions this panorama cannot be laid over the other one")

    log(f"Saving {w}x{h} panorama")
    pano_path = os.path.join(output_dir, panorama_name)
    result_path = os.path.join(output_dir, result_name)
    result = {
        "panorama": pano_path,
        "images": images,
        "included_images": included,
        "width": int(w),
        "height": int(h),
        "gps_aligned": bool(stitcher.gps_aligned),
        "estimated_gsd": _positive_or_none(estimated_gsd),
        "pano_scale": _positive_or_none(pano_scale),
        "geotransform": geotransform,
        "view": view_result,
        "poses": stitcher.poses(geotransform),
        "aligned": bool(layout.aligned and stitcher.gps_aligned and stitcher.align_refined),
    }
    temps = []  # (temporary file, final path), the result last
    try:
        try:
            temps.append((write_image_atomic(pano_path, bgra), pano_path))
            if view_path:
                params = (cv2.IMWRITE_WEBP_QUALITY, VIEW_QUALITY)
                temps.append((write_image_atomic(view_path, view_pixels, params), view_path))
            result_tmp = write_json_temp(result_path, result)
        except OSError as exc:
            raise UserError(f"Could not save the panorama to {output_dir}: {exc.strerror or exc}") from None
    except BaseException:
        for tmp, _ in temps:
            _remove(tmp)
        raise
    # result.json is the commit point. Drop the old one first, so a kill between the
    # replaces leaves no result rather than the old one describing the new pixels.
    _remove(result_path)
    try:
        for tmp, final in temps:
            os.replace(tmp, final)
    except OSError as exc:
        for tmp, _ in temps:
            _remove(tmp)
        _remove(result_tmp)
        raise UserError(f"Could not save the panorama to {output_dir}: {exc.strerror or exc}") from None
    try:
        os.replace(result_tmp, result_path)  # last: only now does the new panorama count
    except OSError as exc:
        _remove(result_tmp)
        raise UserError(f"Could not save the result to {output_dir}: {exc.strerror or exc}") from None

    if result["estimated_gsd"] is not None:
        log(f"Estimated GSD from GPS: {estimated_gsd:.4f} m per image pixel")
    transparent = 100.0 * float((alpha == 0).mean())
    log(f"Done: {w}x{h} panorama from {len(included)} images in {time.perf_counter() - started:.0f} s "
        f"({transparent:.0f}% empty background)")


def _friendly_stitching_error(exc):
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else "Stitching failed."
    if text.startswith("No match exceeds"):
        return ("The images could not be matched to each other; make sure the photos overlap "
                "and show the same area.")
    if text.startswith("Homography estimation failed"):
        return ("Could not work out how the images fit together; make sure the photos overlap "
                "and come from one flight.")
    if text.startswith("Cannot read image "):
        return f"Cannot read {os.path.basename(text[len('Cannot read image '):])}."
    return text


def main(argv=None):
    parser = argparse.ArgumentParser(description="Stitch drone photos into a north-up panorama.")
    parser.add_argument("--input", required=True, help='JSON file: {"images": ["/abs/a.jpg", ...]}')
    parser.add_argument("--output-dir", required=True, help="folder for panorama.png and result.json")
    parser.add_argument("--panorama-name", default=PANORAMA_NAME, help="file name of the panorama")
    parser.add_argument("--result-name", default=RESULT_NAME, help="file name of the result")
    args = parser.parse_args(argv)
    warnings.simplefilter("ignore", StitchingWarning)  # we print our own, shorter messages
    try:
        run(args.input, args.output_dir, args.panorama_name, args.result_name)
    except UserError as exc:
        log(f"ERROR: {exc}")
        return 2
    except StitchingError as exc:
        log(f"ERROR: {_friendly_stitching_error(exc)}")
        return 2
    except MemoryError:
        log("ERROR: Ran out of memory while stitching; try fewer images.")
        return 2
    except cv2.error as exc:
        traceback.print_exc()
        detail = (getattr(exc, "err", "") or str(exc)).strip().splitlines()
        log(f"ERROR: OpenCV failed while stitching: {detail[-1] if detail else 'unknown error'}")
        return 2
    except Exception as exc:
        traceback.print_exc()
        log(f"ERROR: Stitching failed unexpectedly: {type(exc).__name__}: {exc}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
