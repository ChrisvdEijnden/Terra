"""Terra exporter: the orthomosaic as a GeoTIFF and the water mask as a KMZ polygon.

    python3 -u terra_export.py --job <dir>/export-job.tmp

Job (JSON, written by Rust):
  {"panorama": "/abs/panorama.png", "width": 100, "height": 50, "name": "Polder",
   "geotransform": [lon0, dlon, 0, lat0, 0, dlat],
   "orthomosaic": "/abs/out.tif" or null,
   "polygon": "/abs/out.kmz" or null, "mask": "/abs/mask.bin" or null}

The mask holds one byte per panorama pixel (row by row), non-zero for water.
A handled failure ends with "ERROR: <sentence>" on stderr and exit code 2. Every output
appears under its final name only when it is complete.
"""

import argparse
import json
import os
import struct
import sys
import tempfile
import traceback
import zipfile
import zlib
from xml.sax.saxutils import escape

try:
    import cv2
    import numpy as np
except ImportError as exc:  # pragma: no cover - depends on the environment
    print(f"ERROR: The Python package '{exc.name}' is not installed for {sys.executable}.", file=sys.stderr)
    sys.exit(2)

ROWS_PER_STRIP = 64
# Douglas-Peucker tolerance in panorama pixels: removes the pixel staircase.
SIMPLIFY_PIXELS = 1.0
# KML colours are aabbggrr; these match the overlay on the Dashboard.
KML_EDGE = "ff88940d"
KML_FILL = "80b8a394"

# TIFF field types
SHORT, LONG, DOUBLE = 3, 4, 12
_TYPE_CODE = {SHORT: "H", LONG: "I", DOUBLE: "d"}


class UserError(Exception):
    """A failure we can explain to the user in one sentence."""


def log(message):
    print(message, file=sys.stderr, flush=True)


def _replace_when_done(path, write):
    """Calls write(tmp) on a temp file next to path and moves it to path afterwards."""
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=os.path.dirname(path))
    os.close(fd)
    try:
        write(tmp)
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp, 0o666 & ~umask)  # mkstemp creates 0600; use normal file permissions
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- GeoTIFF


def _tiff_entry(tag, field_type, values):
    return tag, field_type, len(values), struct.pack(f"<{len(values)}{_TYPE_CODE[field_type]}", *values)


def _geotiff_tags(width, height, geotransform):
    lon0, dlon, _, lat0, _, dlat = geotransform
    geokeys = [
        1, 1, 0, 3,  # directory header: version 1.1.0, 3 keys
        1024, 0, 1, 2,  # GTModelTypeGeoKey = geographic
        1025, 0, 1, 1,  # GTRasterTypeGeoKey = pixel is area
        2048, 0, 1, 4326,  # GeographicTypeGeoKey = WGS84
    ]
    return [
        _tiff_entry(256, LONG, [width]),
        _tiff_entry(257, LONG, [height]),
        _tiff_entry(258, SHORT, [8, 8, 8, 8]),  # BitsPerSample
        _tiff_entry(259, SHORT, [8]),  # Compression = Deflate
        _tiff_entry(262, SHORT, [2]),  # Photometric = RGB
        _tiff_entry(277, SHORT, [4]),  # SamplesPerPixel
        _tiff_entry(278, LONG, [ROWS_PER_STRIP]),
        _tiff_entry(284, SHORT, [1]),  # PlanarConfiguration = chunky
        _tiff_entry(317, SHORT, [2]),  # Predictor = horizontal differencing
        _tiff_entry(338, SHORT, [2]),  # ExtraSamples = unassociated alpha
        _tiff_entry(339, SHORT, [1, 1, 1, 1]),  # SampleFormat = unsigned
        _tiff_entry(33550, DOUBLE, [abs(dlon), abs(dlat), 0.0]),  # ModelPixelScale
        _tiff_entry(33922, DOUBLE, [0.0, 0.0, 0.0, lon0, lat0, 0.0]),  # ModelTiepoint
        _tiff_entry(34735, SHORT, geokeys),  # GeoKeyDirectory
    ]


def _write_ifd(f, entries):
    """Appends the directory and its out-of-line values; returns the directory's offset."""
    entries = sorted(entries, key=lambda e: e[0])
    if f.tell() % 2:
        f.write(b"\0")
    ifd_offset = f.tell()
    data_offset = ifd_offset + 2 + 12 * len(entries) + 4
    directory, values = struct.pack("<H", len(entries)), b""
    for tag, field_type, count, data in entries:
        directory += struct.pack("<HHI", tag, field_type, count)
        if len(data) <= 4:
            directory += data.ljust(4, b"\0")
        else:
            directory += struct.pack("<I", data_offset + len(values))
            values += data + (b"\0" if len(data) % 2 else b"")
    f.write(directory + struct.pack("<I", 0) + values)
    return ifd_offset


def write_geotiff(path, rgba, geotransform):
    """Writes an 8-bit RGBA GeoTIFF: Deflate compressed, north-up, WGS84."""
    height, width = rgba.shape[:2]
    with open(path, "wb") as f:
        f.write(b"II*\0" + struct.pack("<I", 0))  # the directory offset is patched in below
        offsets, counts = [], []
        for top in range(0, height, ROWS_PER_STRIP):
            strip = rgba[top:top + ROWS_PER_STRIP]
            delta = strip.copy()
            delta[:, 1:] = strip[:, 1:] - strip[:, :-1]  # uint8, wraps as the predictor requires
            data = zlib.compress(delta.tobytes(), 6)
            offsets.append(f.tell())
            counts.append(len(data))
            f.write(data)
        entries = _geotiff_tags(width, height, geotransform)
        entries += [_tiff_entry(273, LONG, offsets), _tiff_entry(279, LONG, counts)]
        if f.tell() + 64 + 12 * len(entries) + 8 * len(offsets) >= 2 ** 32:
            raise UserError("The orthomosaic is too large for a GeoTIFF (over 4 GB).")
        ifd_offset = _write_ifd(f, entries)
        f.seek(4)
        f.write(struct.pack("<I", ifd_offset))
        f.flush()
        os.fsync(f.fileno())


def export_orthomosaic(job):
    panorama = cv2.imread(job["panorama"], cv2.IMREAD_UNCHANGED)
    if panorama is None:
        raise UserError("The panorama could not be read.")
    if panorama.ndim != 3 or panorama.shape[2] != 4:
        raise UserError("The panorama has no transparency channel; stitch again.")
    rgba = cv2.cvtColor(panorama, cv2.COLOR_BGRA2RGBA)
    _replace_when_done(job["orthomosaic"], lambda tmp: write_geotiff(tmp, rgba, job["geotransform"]))


# --------------------------------------------------------------------------- polygons


def _boundary_edges(mask):
    """Unit edges between water and non-water, directed so the water is on the right
    when walking (y down). Returns (start x, start y, direction, pixel x, pixel y);
    directions are 0 = +x, 1 = +y, 2 = -x, 3 = -y, and the pixel is the water pixel."""
    water = np.pad(mask != 0, 1)
    inner = water[1:-1, 1:-1]
    sides = [
        (inner & ~water[:-2, 1:-1], 0, 0, 0),  # top edge, walking +x
        (inner & ~water[1:-1, 2:], 1, 1, 0),  # right edge, walking +y
        (inner & ~water[2:, 1:-1], 2, 1, 1),  # bottom edge, walking -x
        (inner & ~water[1:-1, :-2], 3, 0, 1),  # left edge, walking -y
    ]
    parts = []
    for side, direction, dx, dy in sides:
        y, x = np.nonzero(side)
        parts.append((x + dx, y + dy, np.full(x.size, direction), x, y))
    return tuple(np.concatenate(column).astype(np.int64) for column in zip(*parts))


def _next_edges(x, y, direction, width):
    """For every edge, the index of the edge that continues it. Where two water pixels
    touch only at a corner the right turn is taken, which keeps the rings apart."""
    step_x, step_y = np.array([1, 0, -1, 0]), np.array([0, 1, 0, -1])
    start = (y * (width + 2) + x) * 4 + direction
    order = np.argsort(start)
    ordered = start[order]
    end = ((y + step_y[direction]) * (width + 2) + x + step_x[direction]) * 4
    following = np.full(x.size, -1, np.int64)
    for turn in (1, 0, 3):  # right, straight on, left
        todo = np.flatnonzero(following < 0)
        if todo.size == 0:
            break
        wanted = end[todo] + (direction[todo] + turn) % 4
        at = np.minimum(np.searchsorted(ordered, wanted), ordered.size - 1)
        found = ordered[at] == wanted
        following[todo[found]] = order[at[found]]
    return following


def _signed_area(ring):
    """Shoelace area of a closed ring; positive when clockwise on screen (y down)."""
    x, y = ring[:, 0].astype(float), ring[:, 1].astype(float)
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _simplified(ring):
    """The ring with its pixel staircase removed, or the ring itself if that would collapse it."""
    small = cv2.approxPolyDP(ring.astype(np.int32).reshape(-1, 1, 2), SIMPLIFY_PIXELS, True).reshape(-1, 2)
    return small if len(small) >= 3 and _signed_area(small) != 0 else ring


def water_polygons(mask):
    """[(outer ring, [hole rings])] along the pixel edges of the water, simplified.
    Rings are (n, 2) integer arrays of pixel-corner coordinates, not repeating the first point."""
    if not np.any(mask):
        return []
    height, width = mask.shape
    x, y, direction, pixel_x, pixel_y = _boundary_edges(mask)
    following = _next_edges(x, y, direction, width).tolist()
    _, components = cv2.connectedComponents((mask != 0).astype(np.uint8), connectivity=4, ltype=cv2.CV_32S)

    grouped = {}
    visited = bytearray(len(following))
    for first in range(len(following)):
        if visited[first]:
            continue
        edges = []
        edge = first
        while not visited[edge]:
            visited[edge] = 1
            edges.append(edge)
            edge = following[edge]
        edges = np.array(edges)
        turns = direction[edges] != np.roll(direction[edges], 1)  # only the corners matter
        ring = np.c_[x[edges][turns], y[edges][turns]]
        group = grouped.setdefault(int(components[pixel_y[first], pixel_x[first]]), {"outer": None, "holes": []})
        if _signed_area(ring) > 0:
            group["outer"] = _simplified(ring)
        else:
            group["holes"].append(_simplified(ring))
    return [(g["outer"], g["holes"]) for g in grouped.values() if g["outer"] is not None]


def _kml_coordinates(ring, geotransform):
    """Closed ring as KML text; reversed, because rings run clockwise for the outside
    and KML wants its outer boundaries counter-clockwise."""
    lon0, a, b, lat0, d, e = geotransform
    points = ring[::-1]
    points = np.r_[points, points[:1]].astype(float)
    lon = lon0 + a * points[:, 0] + b * points[:, 1]
    lat = lat0 + d * points[:, 0] + e * points[:, 1]
    return " ".join(f"{lo:.8f},{la:.8f},0" for lo, la in zip(lon, lat))


def _kml_ring(ring, geotransform):
    return f"<LinearRing><coordinates>{_kml_coordinates(ring, geotransform)}</coordinates></LinearRing>"


def polygons_kml(polygons, geotransform, name):
    body = []
    for outer, holes in polygons:
        inner = "".join(f"<innerBoundaryIs>{_kml_ring(h, geotransform)}</innerBoundaryIs>" for h in holes)
        body.append(
            f"<Polygon><tessellate>1</tessellate>"
            f"<outerBoundaryIs>{_kml_ring(outer, geotransform)}</outerBoundaryIs>{inner}</Polygon>"
        )
    title = escape(name)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        f"<name>{title}</name>"
        f'<Style id="water"><LineStyle><color>{KML_EDGE}</color><width>2</width></LineStyle>'
        f"<PolyStyle><color>{KML_FILL}</color></PolyStyle></Style>"
        f"<Placemark><name>{title}</name><styleUrl>#water</styleUrl>"
        f"<MultiGeometry>{''.join(body)}</MultiGeometry></Placemark>"
        "</Document></kml>\n"
    )


def load_mask(job):
    width, height = job["width"], job["height"]
    try:
        with open(job["mask"], "rb") as f:
            mask = np.frombuffer(f.read(), np.uint8)
    except OSError as exc:
        raise UserError(f"Could not read the water mask: {exc.strerror or exc}") from None
    if mask.size != width * height:
        raise UserError("The water mask does not match the panorama; try again.")
    return mask.reshape(height, width)


def export_polygon(job):
    polygons = water_polygons(load_mask(job))
    if not polygons:
        raise UserError("No water is selected.")
    kml = polygons_kml(polygons, job["geotransform"], job["name"])

    def write(tmp):
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as kmz:
            kmz.writestr("doc.kml", kml.encode("utf-8"))

    _replace_when_done(job["polygon"], write)


# --------------------------------------------------------------------------- main


def run(job_path):
    try:
        with open(job_path, encoding="utf-8") as f:
            job = json.load(f)
    except (OSError, ValueError) as exc:
        raise UserError(f"Could not read the export job: {exc}") from None
    try:
        if job.get("orthomosaic"):
            log("Writing the orthomosaic")
            export_orthomosaic(job)
        if job.get("polygon"):
            log("Writing the water polygons")
            export_polygon(job)
    except OSError as exc:
        raise UserError(str(exc.strerror or exc)) from None  # the app says what failed


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export a Terra panorama as GeoTIFF and KMZ.")
    parser.add_argument("--job", required=True, help="JSON file describing the export")
    args = parser.parse_args(argv)
    try:
        run(args.job)
    except UserError as exc:
        log(f"ERROR: {exc}")
        return 2
    except MemoryError:
        log("ERROR: Ran out of memory while exporting.")
        return 2
    except Exception as exc:
        traceback.print_exc()
        log(f"ERROR: The export failed unexpectedly: {type(exc).__name__}: {exc}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
