"""Tests for terra_export.py: the water polygons in the KMZ and the GeoTIFF writer.

    python3 -m unittest discover -s src-tauri/python
"""

import os
import tempfile
import unittest

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")  # libtiff warns about the GeoTIFF tags

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import terra_export  # noqa: E402

# [lon0, dlon, 0, lat0, 0, dlat]: north-up, like every Terra panorama
GEOTRANSFORM = [5.0, 0.001, 0.0, 52.0, 0.0, -0.001]


def mask_from(rows):
    return np.array([[c == "#" for c in row] for row in rows], np.uint8)


def ring_area(ring):
    return abs(terra_export._signed_area(ring))


class WaterPolygons(unittest.TestCase):
    def setUp(self):
        self.mask = mask_from([
            "......#",  # touches the lake only at a corner: a polygon of its own
            ".#####.",
            ".#####.",
            ".##.##.",  # an island in the lake
            ".#####.",
            ".#####.",
            ".......",
        ])

    def test_lake_with_island_and_a_separate_pond(self):
        polygons = terra_export.water_polygons(self.mask)
        self.assertEqual(len(polygons), 2)
        polygons.sort(key=lambda p: -ring_area(p[0]))
        (lake, lake_holes), (pond, pond_holes) = polygons
        self.assertEqual(ring_area(lake), 25)
        self.assertEqual([ring_area(h) for h in lake_holes], [1])
        self.assertEqual((ring_area(pond), pond_holes), (1, []))
        # outer rings clockwise on screen (y down), holes the other way
        self.assertGreater(terra_export._signed_area(lake), 0)
        self.assertLess(terra_export._signed_area(lake_holes[0]), 0)

    def test_polygon_area_matches_the_counted_pixels(self):
        water = sum(ring_area(outer) - sum(ring_area(h) for h in holes)
                    for outer, holes in terra_export.water_polygons(self.mask))
        self.assertEqual(water, int(self.mask.sum()))

    def test_kml_outer_rings_run_counter_clockwise_on_the_map(self):
        outer, _ = terra_export.water_polygons(mask_from(["##", "##"]))[0]
        text = terra_export._kml_coordinates(outer, GEOTRANSFORM)
        points = np.array([[float(v) for v in p.split(",")[:2]] for p in text.split()])
        np.testing.assert_array_equal(points[0], points[-1])  # closed
        lon, lat = points[:-1, 0], points[:-1, 1]
        shoelace = 0.5 * np.sum(lon * np.roll(lat, -1) - np.roll(lon, -1) * lat)
        self.assertGreater(shoelace, 0, "KML wants outer boundaries counter-clockwise")
        self.assertAlmostEqual(lon.min(), 5.0)
        self.assertAlmostEqual(lat.max(), 52.0)
        self.assertAlmostEqual(lat.min(), 52.0 - 0.002)

    def test_no_water_is_refused(self):
        self.assertEqual(terra_export.water_polygons(np.zeros((3, 3), np.uint8)), [])


class GeoTiff(unittest.TestCase):
    def test_pixels_survive_the_round_trip(self):
        rng = np.random.default_rng(1)
        # more rows than one strip, so the strip offsets are exercised
        bgra = rng.integers(0, 256, (terra_export.ROWS_PER_STRIP + 7, 33, 4), dtype=np.uint8)
        # as Terra's mosaics are: opaque, or transparent and black (OpenCV's reader
        # premultiplies alpha, so other values would not come back as written)
        bgra[..., 3] = np.where(bgra[..., 3] < 128, 0, 255)
        bgra[bgra[..., 3] == 0] = 0
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.tif")
            terra_export.write_geotiff(path, bgra, GEOTRANSFORM)
            back = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        self.assertIsNotNone(back, "OpenCV could not read the GeoTIFF")
        np.testing.assert_array_equal(back, bgra)


if __name__ == "__main__":
    unittest.main()
