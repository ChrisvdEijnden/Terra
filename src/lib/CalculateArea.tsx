const NOISE_AREA_PX = 35; // masks smaller than this are treated as noise

export type LabelId = number;

export interface WaterMaskResult {
    labels: Int32Array;
    validLabels: Set<LabelId>;
    areas: Map<LabelId, number>;
    selectedMask: Uint8Array;
    pixelCount: number;
    width: number;
    height: number;
}

function rgbToOpenCvHue(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;

    if (diff === 0) return 0;

    let hueDegrees: number;
    if (max === r) {
        hueDegrees = (60 * ((g - b) / diff) + 360) % 360;
    } else if (max === g) {
        hueDegrees = (60 * ((b - r) / diff) + 120) % 360;
    } else {
        hueDegrees = (60 * ((r - g) / diff) + 240) % 360;
    }

    return Math.round(hueDegrees / 2);
}

export function getHueAtPixel(imageData: ImageData, x: number, y: number): number {
    const { data, width, height } = imageData;
    if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(`getHueAtPixel: (${x}, ${y}) is outside the ${width}x${height} image`);
    }
    const idx = (y * width + x) * 4;
    return rgbToOpenCvHue(data[idx], data[idx + 1], data[idx + 2]);
}

function computeHueChannel(imageData: ImageData): Uint8Array {
    const { data, width, height } = imageData;
    const hue = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < hue.length; p++, i += 4) {
        hue[p] = rgbToOpenCvHue(data[i], data[i + 1], data[i + 2]);
    }
    return hue;
}

function connectedComponents(
    mask: Uint8Array,
    width: number,
    height: number
): { labels: Int32Array; areas: Map<LabelId, number> } {
    const labels = new Int32Array(width * height); // 0 = unlabeled/background
    const areas = new Map<LabelId, number>();
    const stack: number[] = [];
    let nextLabel = 1;

    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || labels[start] !== 0) continue;

        const label = nextLabel++;
        let area = 0;
        labels[start] = label;
        stack.push(start);

        while (stack.length > 0) {
            const idx = stack.pop() as number;
            area++;

            const x = idx % width;
            const y = (idx / width) | 0;

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;

                    const nIdx = ny * width + nx;
                    if (mask[nIdx] && labels[nIdx] === 0) {
                        labels[nIdx] = label;
                        stack.push(nIdx);
                    }
                }
            }
        }

        areas.set(label, area);
    }

    return { labels, areas };
}

export function computeWaterMask(
    imageData: ImageData,
    clickedHue: number | null,
    toleranceHue: number,
    deselectedLabels: Set<LabelId> = new Set()
): WaterMaskResult | null {
    if (clickedHue === null) return null;

    const { width, height } = imageData;
    const hueChannel = computeHueChannel(imageData);

    const rawMask = new Uint8Array(hueChannel.length);
    for (let i = 0; i < hueChannel.length; i++) {
        let diff = Math.abs(hueChannel[i] - clickedHue);
        diff = Math.min(diff, 180 - diff); // hue wraps at 180
        rawMask[i] = diff <= toleranceHue ? 1 : 0;
    }

    const { labels, areas } = connectedComponents(rawMask, width, height);

    const validLabels = new Set<LabelId>();
    areas.forEach((area, label) => {
        if (area >= NOISE_AREA_PX) validLabels.add(label);
    });

    const selectedMask = new Uint8Array(labels.length);
    let pixelCount = 0;
    for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        if (label !== 0 && validLabels.has(label) && !deselectedLabels.has(label)) {
            selectedMask[i] = 1;
            pixelCount++;
        }
    }

    return { labels, validLabels, areas, selectedMask, pixelCount, width, height };
}

export function toggleAreaSelection(deselectedLabels: Set<LabelId>, labelId: LabelId): Set<LabelId> {
    const next = new Set(deselectedLabels);
    if (next.has(labelId)) {
        next.delete(labelId);
    } else {
        next.add(labelId);
    }
    return next;
}

export function labelAt(result: WaterMaskResult, imgX: number, imgY: number): LabelId | null {
    const idx = imgY * result.width + imgX;
    const label = result.labels[idx];
    return result.validLabels.has(label) ? label : null;
}


export function buildOverlayImageData(
    result: WaterMaskResult,
    deselectedLabels: Set<LabelId>
): ImageData {
    const { width, height, labels, selectedMask, validLabels } = result;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < selectedMask.length; i++) {
        if (selectedMask[i]) {
            const o = i * 4;
            data[o] = 0x94;
            data[o + 1] = 0xa3;
            data[o + 2] = 0xb8;
            data[o + 3] = 128;
        }
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const label = labels[idx];
            if (label === 0 || !validLabels.has(label)) continue;

            const isBoundary =
                x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
                labels[idx - 1] !== label ||
                labels[idx + 1] !== label ||
                labels[idx - width] !== label ||
                labels[idx + width] !== label;

            if (!isBoundary) continue;

            const o = idx * 4;
            if (deselectedLabels.has(label)) {
                data[o] = 160; data[o + 1] = 160; data[o + 2] = 160; data[o + 3] = 255; // gray
            } else {
                data[o] = 0x0d; data[o + 1] = 0x94; data[o + 2] = 0x88; data[o + 3] = 255; // #0D9488
            }
        }
    }

    return new ImageData(data, width, height);
}

export function calculateArea(pixelCount: number, gsdMeters: number): number {
    if (!Number.isFinite(gsdMeters) || gsdMeters <= 0) return NaN;
    return (gsdMeters ** 2) * pixelCount / 10000;
}

export default calculateArea;