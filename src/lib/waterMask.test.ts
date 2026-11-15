// Run with: node --experimental-strip-types --test src/lib/waterMask.test.ts
// (pnpm test). Covers the numbers Terra reports: which pixels count as water and
// how many hectares they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    areaHectares,
    buildMask,
    computeHueChannel,
    countSelectedPixels,
    countSelectedPixelsInRegion,
    labelComponents,
    markBoundaries,
    pixelHue,
    rasterizeLasso,
    REGION_INSIDE,
} from "./waterMask.ts";

/** 0/1 grid from rows of "#" (on) and "." (off). */
function grid(rows: string[]): { values: Uint8Array; width: number; height: number } {
    const width = rows[0].length;
    const values = new Uint8Array(rows.length * width);
    rows.forEach((row, y) => [...row].forEach((c, x) => (values[y * width + x] = c === "#" ? 1 : 0)));
    return { values, width, height: rows.length };
}

test("the fast hue channel gives the same hue as the reference formula", () => {
    assert.equal(pixelHue(0, 0, 255), 120); // blue: 240° / 2
    assert.equal(pixelHue(200, 200, 200), 255); // grey: no usable hue
    const n = 4096;
    const rgba = new Uint8Array(n * 4);
    let seed = 1;
    for (let i = 0; i < rgba.length; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        rgba[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    const hue = computeHueChannel(rgba, n, 1);
    for (let p = 0; p < n; p++) {
        assert.equal(hue[p], pixelHue(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]), `pixel ${p}`);
    }
});

test("water patches are 8-connected, and noise and clicked-away patches are not counted", () => {
    const { values, width, height } = grid([
        "##....", //
        "##....",
        "..#...", // touches the 2x2 block at a corner: same patch
        ".....#",
        "...###",
    ]);
    const { labels, areas, count } = labelComponents(values, width, height);
    assert.equal(count, 2);
    assert.deepEqual([...areas], [0, 5, 4]);
    markBoundaries(labels, width, height);

    const none = new Set<number>();
    assert.equal(countSelectedPixels(areas, 0, none), 9);
    assert.equal(countSelectedPixels(areas, 5, none), 5, "the 4-pixel patch is noise");
    assert.equal(countSelectedPixels(areas, 0, new Set([1])), 4);

    // the saved mask holds exactly the counted pixels
    const mask = new Uint8Array(width * height);
    buildMask(labels, areas, 0, new Set([2]), mask);
    assert.equal(mask.reduce((a, b) => a + b, 0), 5);
});

test("a lasso keeps only the water whose pixel centres are inside it", () => {
    const region = rasterizeLasso(
        [
            { x: 1, y: 1 },
            { x: 4, y: 1 },
            { x: 4, y: 4 },
            { x: 1, y: 4 },
        ],
        6,
        6
    );
    assert.equal(region.filter((r) => r === REGION_INSIDE).length, 9);

    const { values } = grid(["######", "######", "######", "######", "######", "######"]);
    const { labels, areas } = labelComponents(values, 6, 6);
    markBoundaries(labels, 6, 6);
    const none = new Set<number>();
    assert.equal(countSelectedPixelsInRegion(labels, areas, 0, none, region), 9);
    const mask = new Uint8Array(36);
    buildMask(labels, areas, 0, none, mask, region);
    assert.equal(mask.reduce((a, b) => a + b, 0), 9);
});

test("hectares come from the photo GSD and the panorama scale", () => {
    // 0.1 m per photo pixel, panorama at half size: 0.2 m per panorama pixel
    assert.ok(Math.abs(areaHectares(1000, 0.1, 0.5)! - 0.004) < 1e-12);
    assert.ok(Math.abs(areaHectares(10_000, 1)! - 1) < 1e-12, "100 x 100 m is one hectare");
    assert.equal(areaHectares(1000, null), null);
    assert.equal(areaHectares(1000, 0), null);
    assert.equal(areaHectares(1000, 0.1, null), areaHectares(1000, 0.1, 1), "no scale: the photo's own");
});
