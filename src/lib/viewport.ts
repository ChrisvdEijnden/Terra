// Pure zoom/pan maths for the image canvas (no DOM). All values in CSS pixels.

export interface View {
    /** Screen CSS pixels per image pixel. */
    scale: number;
    /** Screen position of image pixel (0, 0). */
    offsetX: number;
    offsetY: number;
}

export interface Size {
    width: number;
    height: number;
}

/** Free space kept around the image so nothing hides under the floating controls. */
export interface Padding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export const DEFAULT_PADDING: Padding = { top: 16, right: 16, bottom: 64, left: 16 };
/** Maximum zoom: 32 screen pixels per image pixel. */
export const MAX_SCALE = 32;
/** Minimum zoom relative to the fit scale. */
export const MIN_FIT_FACTOR = 0.5;

export function fitScale(image: Size, viewport: Size, pad: Padding = DEFAULT_PADDING): number {
    const w = Math.max(1, viewport.width - pad.left - pad.right);
    const h = Math.max(1, viewport.height - pad.top - pad.bottom);
    return Math.min(w / image.width, h / image.height);
}

export function scaleLimits(image: Size, viewport: Size, pad: Padding = DEFAULT_PADDING): { min: number; max: number } {
    const fit = fitScale(image, viewport, pad);
    return { min: fit * MIN_FIT_FACTOR, max: Math.max(MAX_SCALE, fit) };
}

/** Contain-fit: the whole image visible, centred in the padded area. */
export function fitView(image: Size, viewport: Size, pad: Padding = DEFAULT_PADDING): View {
    const scale = fitScale(image, viewport, pad);
    const areaW = viewport.width - pad.left - pad.right;
    const areaH = viewport.height - pad.top - pad.bottom;
    return {
        scale,
        offsetX: pad.left + (areaW - image.width * scale) / 2,
        offsetY: pad.top + (areaH - image.height * scale) / 2,
    };
}

function clampAxis(offset: number, drawn: number, viewportLen: number, padStart: number, padEnd: number): number {
    // A small image stays inside the padded area; a large one can be panned until
    // either edge reaches the padding, so every pixel can be brought on screen.
    const a = padStart;
    const b = viewportLen - padEnd - drawn;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.min(hi, Math.max(lo, offset));
}

export function clampView(view: View, image: Size, viewport: Size, pad: Padding = DEFAULT_PADDING): View {
    const { min, max } = scaleLimits(image, viewport, pad);
    const scale = Math.min(max, Math.max(min, view.scale));
    return {
        scale,
        offsetX: clampAxis(view.offsetX, image.width * scale, viewport.width, pad.left, pad.right),
        offsetY: clampAxis(view.offsetY, image.height * scale, viewport.height, pad.top, pad.bottom),
    };
}

/** Zoom by factor keeping the image point under (anchorX, anchorY) fixed. */
export function zoomAt(
    view: View,
    factor: number,
    anchorX: number,
    anchorY: number,
    image: Size,
    viewport: Size,
    pad: Padding = DEFAULT_PADDING
): View {
    const { min, max } = scaleLimits(image, viewport, pad);
    const scale = Math.min(max, Math.max(min, view.scale * factor));
    const ratio = scale / view.scale;
    return clampView(
        {
            scale,
            offsetX: anchorX - (anchorX - view.offsetX) * ratio,
            offsetY: anchorY - (anchorY - view.offsetY) * ratio,
        },
        image,
        viewport,
        pad
    );
}

export function panBy(view: View, dx: number, dy: number, image: Size, viewport: Size, pad: Padding = DEFAULT_PADDING): View {
    return clampView({ ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }, image, viewport, pad);
}

/** Image pixel under a screen point (may be outside the image). */
export function screenToImage(view: View, x: number, y: number): { x: number; y: number } {
    return {
        x: Math.floor((x - view.offsetX) / view.scale),
        y: Math.floor((y - view.offsetY) / view.scale),
    };
}

/**
 * After a viewport resize keep the image point that was at the old centre at
 * the new centre (same scale), then clamp.
 */
export function resizeView(view: View, oldViewport: Size, newViewport: Size, image: Size, pad: Padding = DEFAULT_PADDING): View {
    const cx = (oldViewport.width / 2 - view.offsetX) / view.scale;
    const cy = (oldViewport.height / 2 - view.offsetY) / view.scale;
    return clampView(
        {
            scale: view.scale,
            offsetX: newViewport.width / 2 - cx * view.scale,
            offsetY: newViewport.height / 2 - cy * view.scale,
        },
        image,
        newViewport,
        pad
    );
}
