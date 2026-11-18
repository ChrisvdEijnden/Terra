// Pure maths for the water mask: hue channel, colour matching, connected
// components, noise filtering, overlay colouring and the area formula.
//
// No DOM access and only erasable TypeScript syntax, so this module can run in
// the browser, in the mask Web Worker and under `node --experimental-strip-types`.

export type LabelId = number;

/** Hue value used for pixels that can never be selected (no data, too grey, too dark). */
export const INELIGIBLE = 255;
/** Minimum saturation (OpenCV 0-255 scale) for a pixel to have a usable hue. */
export const MIN_SATURATION = 26;
/** Minimum value/brightness (OpenCV 0-255 scale) for a pixel to have a usable hue. */
export const MIN_VALUE = 26;
/** OpenCV 8-bit hue range is 0..179. */
export const HUE_RANGE = 180;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * OpenCV-style hue (0..179) of one RGBA pixel, or INELIGIBLE when the pixel has
 * no data (alpha 0), is too dark (V < 26) or too grey (S < 26).
 * V = max(r, g, b); S = (max - min) / max * 255; H = round(deg / 2) % 180.
 */
export function pixelHue(r: number, g: number, b: number, a: number = 255): number {
    if (a === 0) return INELIGIBLE;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (max < MIN_VALUE) return INELIGIBLE;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const diff = max - min;
    // S >= 26  <=>  diff / max * 255 >= 26  (integer form, no rounding surprises)
    if (diff * 255 < MIN_SATURATION * max) return INELIGIBLE;

    let deg: number;
    if (max === r) deg = (60 * (g - b)) / diff;
    else if (max === g) deg = 120 + (60 * (b - r)) / diff;
    else deg = 240 + (60 * (r - g)) / diff;
    if (deg < 0) deg += 360;
    return Math.round(deg / 2) % HUE_RANGE;
}

/** Same as pixelHue but reads pixel (x, y) from an RGBA buffer. */
export function hueAt(rgba: ArrayLike<number>, width: number, x: number, y: number): number {
    const i = (y * width + x) * 4;
    return pixelHue(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
}

let sectorHueLut: Uint8Array | null = null;

/**
 * hue = SECTOR_LUT[(sector * 511 + (num + 255)) * 256 + diff], built with the
 * exact same formula as pixelHue (sector 0: max = r, 1: max = g, 2: max = b).
 */
function getSectorHueLut(): Uint8Array {
    if (sectorHueLut) return sectorHueLut;
    const lut = new Uint8Array(3 * 511 * 256);
    for (let sector = 0; sector < 3; sector++) {
        for (let num = -255; num <= 255; num++) {
            const row = (sector * 511 + (num + 255)) * 256;
            for (let diff = 1; diff < 256; diff++) {
                let deg = sector * 120 + (60 * num) / diff;
                if (deg < 0) deg += 360;
                lut[row + diff] = Math.round(deg / 2) % HUE_RANGE;
            }
        }
    }
    sectorHueLut = lut;
    return lut;
}

/**
 * Hue channel for a whole RGBA image: one byte per pixel, 0..179 or INELIGIBLE.
 * Canvas getImageData is un-premultiplied, and alpha-0 pixels read as RGB 0, so
 * the alpha test alone is enough to reject no-data pixels.
 */
export function computeHueChannel(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    out?: Uint8Array
): Uint8Array {
    const n = width * height;
    if (rgba.length < n * 4) throw new Error("computeHueChannel: buffer is smaller than width * height * 4");
    const hue = out && out.length >= n ? out : new Uint8Array(n);
    const lut = getSectorHueLut();

    // One 32-bit read per pixel when the buffer is aligned (always true for ImageData).
    const aligned = rgba.byteOffset % 4 === 0;
    const words = aligned ? new Uint32Array(rgba.buffer, rgba.byteOffset, n) : null;
    const little = LITTLE_ENDIAN;

    for (let p = 0; p < n; p++) {
        let r: number, g: number, b: number, a: number;
        if (words) {
            const v = words[p];
            if (little) {
                r = v & 255;
                g = (v >>> 8) & 255;
                b = (v >>> 16) & 255;
                a = v >>> 24;
            } else {
                r = v >>> 24;
                g = (v >>> 16) & 255;
                b = (v >>> 8) & 255;
                a = v & 255;
            }
        } else {
            const i = p * 4;
            r = rgba[i];
            g = rgba[i + 1];
            b = rgba[i + 2];
            a = rgba[i + 3];
        }
        if (a === 0) {
            hue[p] = INELIGIBLE;
            continue;
        }
        let max: number, min: number, num: number, sector: number;
        if (r >= g && r >= b) {
            max = r;
            min = g < b ? g : b;
            num = g - b;
            sector = 0;
        } else if (g >= b) {
            max = g;
            min = r < b ? r : b;
            num = b - r;
            sector = 1;
        } else {
            max = b;
            min = r < g ? r : g;
            num = r - g;
            sector = 2;
        }
        const diff = max - min;
        if (max < MIN_VALUE || diff * 255 < MIN_SATURATION * max) {
            hue[p] = INELIGIBLE;
            continue;
        }
        hue[p] = lut[(sector * 511 + num + 255) * 256 + diff];
    }
    return hue;
}

/** Circular distance between two hues on the 0..179 scale. */
export function hueDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % HUE_RANGE;
    return d > HUE_RANGE / 2 ? HUE_RANGE - d : d;
}

/** Lookup table over hue bytes: 1 when the hue matches refHue within tolerance. INELIGIBLE never matches. */
export function hueMatchLut(refHue: number, tolerance: number): Uint8Array {
    const lut = new Uint8Array(256);
    for (let h = 0; h < HUE_RANGE; h++) lut[h] = hueDistance(h, refHue) <= tolerance ? 1 : 0;
    return lut; // 180..255 (incl. INELIGIBLE) stay 0
}

/** LUT for plain 0/1 (or 0/non-zero) masks. */
export const BINARY_LUT: Uint8Array = (() => {
    const lut = new Uint8Array(256).fill(1);
    lut[0] = 0;
    return lut;
})();

export interface Components {
    /** Label per pixel, 0 = not selected, 1..count = component id. */
    labels: Int32Array;
    /** areas[label] = pixel count of that component (areas[0] = 0). Length count + 1. */
    areas: Int32Array;
    count: number;
    /** The (possibly grown) stack, so callers can reuse it for the next run. */
    stack: Int32Array;
}

/**
 * 8-connected component labelling of the pixels where onLut[values[i]] !== 0.
 * Iterative flood fill with a preallocated Int32Array stack (grown only if it
 * turns out to be too small; it never needs more entries than "on" pixels).
 */
export function labelComponents(
    values: Uint8Array,
    width: number,
    height: number,
    onLut: Uint8Array = BINARY_LUT,
    stack?: Int32Array,
    labelsOut?: Int32Array
): Components {
    const n = width * height;
    const labels = labelsOut && labelsOut.length === n ? labelsOut : new Int32Array(n);
    if (labels === labelsOut) labels.fill(0);
    let stk = stack && stack.length > 0 ? stack : new Int32Array(Math.max(16, Math.min(n, 1 << 16)));
    let areas = new Int32Array(1024);
    let count = 0;
    const wm1 = width - 1;
    const lastRow = n - width;

    for (let start = 0; start < n; start++) {
        if (labels[start] !== 0 || onLut[values[start]] === 0) continue;

        const label = ++count;
        if (label >= areas.length) {
            const grown = new Int32Array(areas.length * 2);
            grown.set(areas);
            areas = grown;
        }
        labels[start] = label;
        let sp = 0;
        stk[sp++] = start;
        let area = 0;

        while (sp > 0) {
            const idx = stk[--sp];
            area++;
            const x = idx % width;
            const hasL = x > 0;
            const hasR = x < wm1;

            // Make sure 8 more entries fit before visiting the neighbours.
            if (sp + 8 > stk.length) {
                const grown = new Int32Array(Math.min(Math.max(stk.length * 2, sp + 8), n + 8));
                grown.set(stk.subarray(0, sp));
                stk = grown;
            }

            if (idx >= width) {
                const up = idx - width;
                if (hasL && labels[up - 1] === 0 && onLut[values[up - 1]] !== 0) {
                    labels[up - 1] = label;
                    stk[sp++] = up - 1;
                }
                if (labels[up] === 0 && onLut[values[up]] !== 0) {
                    labels[up] = label;
                    stk[sp++] = up;
                }
                if (hasR && labels[up + 1] === 0 && onLut[values[up + 1]] !== 0) {
                    labels[up + 1] = label;
                    stk[sp++] = up + 1;
                }
            }
            if (hasL && labels[idx - 1] === 0 && onLut[values[idx - 1]] !== 0) {
                labels[idx - 1] = label;
                stk[sp++] = idx - 1;
            }
            if (hasR && labels[idx + 1] === 0 && onLut[values[idx + 1]] !== 0) {
                labels[idx + 1] = label;
                stk[sp++] = idx + 1;
            }
            if (idx < lastRow) {
                const down = idx + width;
                if (hasL && labels[down - 1] === 0 && onLut[values[down - 1]] !== 0) {
                    labels[down - 1] = label;
                    stk[sp++] = down - 1;
                }
                if (labels[down] === 0 && onLut[values[down]] !== 0) {
                    labels[down] = label;
                    stk[sp++] = down;
                }
                if (hasR && labels[down + 1] === 0 && onLut[values[down + 1]] !== 0) {
                    labels[down + 1] = label;
                    stk[sp++] = down + 1;
                }
            }
        }
        areas[label] = area;
    }

    return { labels, areas: areas.slice(0, count + 1), count, stack: stk };
}

/**
 * Marks component boundary pixels (a 4-neighbour with another label, or the
 * image edge) by negating their label in place. Use labelOf() to read labels
 * afterwards. Lets the overlay draw outlines in the same single LUT pass.
 */
export function markBoundaries(labels: Int32Array, width: number, height: number): void {
    const wm1 = width - 1;
    const hm1 = height - 1;
    for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
            const l = labels[i];
            if (l === 0) continue;
            if (x === 0 || y === 0 || x === wm1 || y === hm1) {
                labels[i] = -l;
                continue;
            }
            // left/up were already visited and may be negated; right/down are untouched
            const left = labels[i - 1];
            const up = labels[i - width];
            if (
                (left < 0 ? -left : left) !== l ||
                (up < 0 ? -up : up) !== l ||
                labels[i + 1] !== l ||
                labels[i + width] !== l
            ) {
                labels[i] = -l;
            }
        }
    }
}

/** Label id at a pixel index, ignoring the boundary sign. */
export function labelOf(labels: Int32Array, index: number): LabelId {
    const l = labels[index];
    return l < 0 ? -l : l;
}

/** True when a label survives the noise threshold. */
export function isKept(areas: Int32Array, label: LabelId, noise: number): boolean {
    return label > 0 && label < areas.length && areas[label] >= noise;
}

/**
 * Selectable label under (x, y): the component id when it passes the noise
 * threshold, otherwise null. O(1).
 */
export function selectableLabelAt(
    labels: Int32Array,
    areas: Int32Array,
    width: number,
    height: number,
    x: number,
    y: number,
    noise: number
): LabelId | null {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const label = labelOf(labels, y * width + x);
    return isKept(areas, label, noise) ? label : null;
}

/**
 * Selected pixel count = sum of areas of components with area >= noise that are
 * not deselected. O(labels), never touches the pixels.
 */
export function countSelectedPixels(
    areas: Int32Array,
    noise: number,
    deselected: ReadonlySet<LabelId>
): number {
    let total = 0;
    for (let l = 1; l < areas.length; l++) {
        const a = areas[l];
        if (a >= noise) total += a;
    }
    for (const l of deselected) {
        if (isKept(areas, l, noise)) total -= areas[l];
    }
    return total;
}

export function toggleLabel(deselected: ReadonlySet<LabelId>, label: LabelId): Set<LabelId> {
    const next = new Set(deselected);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return next;
}

/** Packs RGBA bytes into a uint32 matching the platform's ImageData byte order. */
export function packRgba(r: number, g: number, b: number, a: number): number {
    return LITTLE_ENDIAN
        ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
        : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export const OVERLAY_FILL = packRgba(0x14, 0xb8, 0xa6, 190); // selected water, translucent brand teal
export const OVERLAY_EDGE = packRgba(0x5e, 0xea, 0xd4, 255); // selected outline, light teal (stands out on purple)
export const OVERLAY_DESELECTED_EDGE = packRgba(160, 160, 160, 255); // deselected outline, grey
export const OVERLAY_OUTSIDE_FILL = packRgba(0xdc, 0x26, 0x26, 128); // outside the lasso, translucent red
export const OVERLAY_OUTSIDE_EDGE = packRgba(0xdc, 0x26, 0x26, 255); // lasso outline, red

export interface Point {
    x: number;
    y: number;
}

/** Lasso region per pixel: outside the lasso, inside it, or outside and on its outline. */
export const REGION_OUTSIDE = 0;
export const REGION_INSIDE = 1;
export const REGION_EDGE = 2;

/** Area of a closed polygon in square pixels (shoelace formula). */
export function polygonArea(points: readonly Point[]): number {
    let twice = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        twice += (points[j].x - points[i].x) * (points[j].y + points[i].y);
    }
    return Math.abs(twice) / 2;
}

/**
 * Rasterizes a closed lasso (image coordinates, any number of loops) into one
 * byte per pixel: REGION_INSIDE where the pixel centre is inside (non-zero
 * winding, so a loop drawn over itself stays inside), REGION_EDGE on the outside
 * pixels next to an inside pixel (the outline), REGION_OUTSIDE elsewhere.
 */
export function rasterizeLasso(points: readonly Point[], width: number, height: number): Uint8Array {
    const region = new Uint8Array(width * height);
    const n = points.length;
    if (n < 3) return region;

    // Crossings of the edges with each row's centre line, as (x, winding direction) pairs.
    const rows: number[][] = new Array(height);
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = points[j];
        const b = points[i];
        if (a.y === b.y) continue;
        const lo = a.y < b.y ? a : b;
        const hi = a.y < b.y ? b : a;
        const dir = b.y > a.y ? 1 : -1;
        // rows whose centre y + 0.5 lies in [lo.y, hi.y)
        const y0 = Math.max(0, Math.ceil(lo.y - 0.5));
        const y1 = Math.min(height, Math.ceil(hi.y - 0.5));
        const slope = (hi.x - lo.x) / (hi.y - lo.y);
        for (let y = y0; y < y1; y++) {
            const x = lo.x + (y + 0.5 - lo.y) * slope;
            (rows[y] ??= []).push(x, dir);
        }
    }

    const order: number[] = [];
    for (let y = 0; y < height; y++) {
        const row = rows[y];
        if (!row) continue;
        const count = row.length / 2;
        order.length = count;
        for (let k = 0; k < count; k++) order[k] = k;
        order.sort((p, q) => row[p * 2] - row[q * 2]);
        let winding = 0;
        let start = 0;
        const base = y * width;
        for (let k = 0; k < count; k++) {
            const x = row[order[k] * 2];
            const before = winding;
            winding += row[order[k] * 2 + 1];
            if (before === 0 && winding !== 0) start = x;
            else if (before !== 0 && winding === 0) {
                // pixels whose centre x + 0.5 lies in [start, x)
                const x0 = Math.max(0, Math.ceil(start - 0.5));
                const x1 = Math.min(width, Math.ceil(x - 0.5));
                if (x1 > x0) region.fill(REGION_INSIDE, base + x0, base + x1);
            }
        }
    }

    // The outline: outside pixels with an inside 4-neighbour.
    const wm1 = width - 1;
    const hm1 = height - 1;
    for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
            if (region[i] === REGION_INSIDE) continue;
            if (
                (x > 0 && region[i - 1] === REGION_INSIDE) ||
                (x < wm1 && region[i + 1] === REGION_INSIDE) ||
                (y > 0 && region[i - width] === REGION_INSIDE) ||
                (y < hm1 && region[i + width] === REGION_INSIDE)
            ) {
                region[i] = REGION_EDGE;
            }
        }
    }
    return region;
}

/** Selected-label lookup: 1 for components that pass the noise threshold and are not deselected. */
function selectedLut(areas: Int32Array, noise: number, deselected: ReadonlySet<LabelId>): Uint8Array {
    const selected = new Uint8Array(areas.length);
    for (let l = 1; l < areas.length; l++) {
        if (areas[l] >= noise && !deselected.has(l)) selected[l] = 1;
    }
    return selected;
}

/** Selected pixel count inside the lasso: the pixels buildMask writes with the same region. O(pixels). */
export function countSelectedPixelsInRegion(
    labels: Int32Array,
    areas: Int32Array,
    noise: number,
    deselected: ReadonlySet<LabelId>,
    region: Uint8Array
): number {
    const selected = selectedLut(areas, noise, deselected);
    const n = Math.min(labels.length, region.length);
    let total = 0;
    for (let i = 0; i < n; i++) {
        if (region[i] !== REGION_INSIDE) continue;
        const v = labels[i];
        total += selected[v < 0 ? -v : v];
    }
    return total;
}

/**
 * Paints everything outside the lasso over an overlay (see buildOverlay): a
 * translucent red fill with a red outline along the lasso. Inside is left as is.
 */
export function paintOutsideRegion(region: Uint8Array, out: Uint32Array): void {
    const n = Math.min(region.length, out.length);
    for (let i = 0; i < n; i++) {
        const r = region[i];
        if (r === REGION_OUTSIDE) out[i] = OVERLAY_OUTSIDE_FILL;
        else if (r === REGION_EDGE) out[i] = OVERLAY_OUTSIDE_EDGE;
    }
}

/**
 * Writes the overlay for labels (boundaries marked by markBoundaries) into out,
 * a Uint32Array view over an RGBA buffer of the same pixel count. One tight
 * pass through a per-label colour LUT.
 */
export function buildOverlay(
    labels: Int32Array,
    areas: Int32Array,
    noise: number,
    deselected: ReadonlySet<LabelId>,
    out: Uint32Array
): void {
    const count = areas.length - 1;
    const fill = new Uint32Array(count + 1);
    const edge = new Uint32Array(count + 1);
    for (let l = 1; l <= count; l++) {
        if (areas[l] < noise) continue;
        if (deselected.has(l)) {
            edge[l] = OVERLAY_DESELECTED_EDGE;
        } else {
            fill[l] = OVERLAY_FILL;
            edge[l] = OVERLAY_EDGE;
        }
    }
    const n = Math.min(labels.length, out.length);
    for (let i = 0; i < n; i++) {
        const v = labels[i];
        out[i] = v >= 0 ? fill[v] : edge[-v];
    }
}

/**
 * Writes the selected water into out, one byte per pixel (1 = water): exactly the
 * pixels counted by countSelectedPixels and filled by buildOverlay. With a lasso
 * region only the water inside it (as countSelectedPixelsInRegion counts it).
 */
export function buildMask(
    labels: Int32Array,
    areas: Int32Array,
    noise: number,
    deselected: ReadonlySet<LabelId>,
    out: Uint8Array,
    region: Uint8Array | null = null
): void {
    const selected = selectedLut(areas, noise, deselected);
    const n = Math.min(labels.length, out.length);
    for (let i = 0; i < n; i++) {
        const v = labels[i];
        out[i] = region && region[i] !== REGION_INSIDE ? 0 : selected[v < 0 ? -v : v];
    }
}

/**
 * Water area in hectares.
 * sourceGsd = metres per full-resolution source-image pixel (the camera GSD);
 * panoScale = panorama pixels per source pixel (1 for a single raw image).
 * panoramaGsd = sourceGsd / panoScale; area = pixels * panoramaGsd^2 / 10000.
 */
export function areaHectares(
    pixelCount: number,
    sourceGsd: number | null,
    panoScale: number | null = 1
): number | null {
    if (sourceGsd === null || !Number.isFinite(sourceGsd) || sourceGsd <= 0) return null;
    const scale = panoScale !== null && Number.isFinite(panoScale) && panoScale > 0 ? panoScale : 1;
    const panoramaGsd = sourceGsd / scale;
    return (pixelCount * panoramaGsd * panoramaGsd) / 10000;
}
