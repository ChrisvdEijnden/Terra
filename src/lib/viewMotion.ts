// Motion for the image canvas (no DOM): animated zoom and fit, the glide after a flick,
// and the resistance past the pan limits. All values in CSS pixels and seconds.

import type { View } from "./viewport.ts";

/** Seconds a zoom or fit takes to settle (critically damped: no overshoot). */
export const VIEW_RESPONSE = 0.35;
/** How fast a flicked image slows down, per second (1/s). Higher stops sooner. */
const GLIDE_FRICTION = 5;
/** Seconds the image takes to spring back from past an edge. */
const EDGE_RESPONSE = 0.4;
/** Below this speed (px/s) a glide is over. */
const REST_SPEED = 8;

/** Progress (0 to 1) of a critically damped spring after t seconds. */
export function springProgress(t: number, response: number = VIEW_RESPONSE): number {
    const w = (2 * Math.PI) / response;
    return 1 - (1 + w * t) * Math.exp(-w * t);
}

/**
 * The view part-way (p from 0 to 1) between two views. Scale changes geometrically about
 * the one screen point both views share, so a zoom looks anchored instead of sliding.
 */
export function interpolateView(from: View, to: View, p: number): View {
    const k = to.scale / from.scale;
    if (Math.abs(k - 1) < 1e-6) {
        return {
            scale: from.scale + (to.scale - from.scale) * p,
            offsetX: from.offsetX + (to.offsetX - from.offsetX) * p,
            offsetY: from.offsetY + (to.offsetY - from.offsetY) * p,
        };
    }
    const kp = Math.pow(k, p);
    const ax = (to.offsetX - from.offsetX * k) / (1 - k);
    const ay = (to.offsetY - from.offsetY * k) / (1 - k);
    return { scale: from.scale * kp, offsetX: ax - (ax - from.offsetX) * kp, offsetY: ay - (ay - from.offsetY) * kp };
}

/** Where past a limit the image is drawn: it follows less the further it is pulled. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
    if (dimension <= 0) return 0;
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** An offset pulled to `raw`, with resistance outside [lo, hi]. */
export function resist(raw: number, lo: number, hi: number, dimension: number): number {
    if (raw < lo) return lo - rubberband(lo - raw, dimension);
    if (raw > hi) return hi + rubberband(raw - hi, dimension);
    return raw;
}

/** Release velocity (px/s) from recent pointer samples; 0 when the pointer had stopped. */
export function releaseVelocity(samples: readonly { t: number; x: number; y: number }[], now: number): { x: number; y: number } {
    const recent = samples.filter((s) => now - s.t <= 100);
    if (recent.length < 2 || now - recent[recent.length - 1].t > 50) return { x: 0, y: 0 };
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/** One axis of a glide: position and velocity. */
export interface Axis {
    x: number;
    v: number;
}

/**
 * Advances one axis by dt seconds: inside [lo, hi] it coasts and slows down, outside it
 * springs back to the limit it crossed, keeping its speed (no jolt at the edge).
 */
export function stepAxis(axis: Axis, dt: number, lo: number, hi: number): Axis {
    let { x, v } = axis;
    const w = (2 * Math.PI) / EDGE_RESPONSE;
    // small fixed steps keep the spring stable whatever the frame rate
    const steps = Math.max(1, Math.ceil(dt / 0.002));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
        const bound = x < lo ? lo : x > hi ? hi : null;
        if (bound === null) {
            const decay = Math.exp(-GLIDE_FRICTION * h);
            x += (v * (1 - decay)) / GLIDE_FRICTION;
            v *= decay;
        } else {
            v += (-w * w * (x - bound) - 2 * w * v) * h;
            x += v * h;
        }
    }
    return { x, v };
}

/** True when the axis is inside its limits and (nearly) still. */
export function axisAtRest(axis: Axis, lo: number, hi: number): boolean {
    const inside = axis.x >= lo - 0.5 && axis.x <= hi + 0.5;
    return inside && Math.abs(axis.v) < REST_SPEED;
}
