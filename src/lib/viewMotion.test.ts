import { test } from "node:test";
import assert from "node:assert/strict";

import { axisAtRest, interpolateView, releaseVelocity, resist, springProgress, stepAxis } from "./viewMotion.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("spring starts at 0, settles at 1 without overshoot", () => {
    close(springProgress(0), 0);
    let prev = 0;
    for (let t = 0.01; t < 2; t += 0.01) {
        const p = springProgress(t);
        assert.ok(p >= prev && p <= 1);
        prev = p;
    }
    close(prev, 1, 1e-4);
});

test("interpolated view hits both ends and keeps the zoom anchor fixed", () => {
    const from = { scale: 1, offsetX: 10, offsetY: 20 };
    // zoom x2 about screen point (100, 50)
    const to = { scale: 2, offsetX: 100 - (100 - 10) * 2, offsetY: 50 - (50 - 20) * 2 };
    const a = interpolateView(from, to, 0);
    const b = interpolateView(from, to, 1);
    close(a.offsetX, 10);
    close(b.offsetX, to.offsetX);
    close(b.scale, 2);
    const mid = interpolateView(from, to, 0.5);
    // the image point under (100, 50) stays there
    close((100 - mid.offsetX) / mid.scale, (100 - from.offsetX) / from.scale);
    close((50 - mid.offsetY) / mid.scale, (50 - from.offsetY) / from.scale);
});

test("interpolated pan at the same scale is linear", () => {
    const v = interpolateView({ scale: 1, offsetX: 0, offsetY: 0 }, { scale: 1, offsetX: 100, offsetY: -50 }, 0.25);
    close(v.offsetX, 25);
    close(v.offsetY, -12.5);
});

test("resistance follows inside the limits and less and less outside", () => {
    assert.equal(resist(5, 0, 10, 500), 5);
    const a = resist(-100, 0, 10, 500);
    const b = resist(-400, 0, 10, 500);
    assert.ok(a < 0 && a > -100);
    assert.ok(b < a && b - a > -300);
});

test("release velocity comes from the last 100 ms, and is 0 after a pause", () => {
    const samples = [
        { t: 0, x: 0, y: 0 },
        { t: 950, x: 0, y: 0 },
        { t: 1000, x: 50, y: -25 },
    ];
    const v = releaseVelocity(samples, 1000);
    close(v.x, 1000);
    close(v.y, -500);
    assert.deepEqual(releaseVelocity(samples, 1200), { x: 0, y: 0 });
});

test("a glide slows to rest inside the limits", () => {
    let axis = { x: 0, v: 500 };
    for (let i = 0; i < 300 && !axisAtRest(axis, -1000, 1000); i++) axis = stepAxis(axis, 1 / 60, -1000, 1000);
    assert.ok(axisAtRest(axis, -1000, 1000));
    // 500 px/s with friction 5/s coasts about 100 px
    assert.ok(axis.x > 90 && axis.x < 100);
});

test("a glide past an edge springs back to it", () => {
    let axis = { x: 0, v: 3000 };
    let furthest = 0;
    for (let i = 0; i < 600 && !axisAtRest(axis, -100, 100); i++) {
        axis = stepAxis(axis, 1 / 60, -100, 100);
        furthest = Math.max(furthest, axis.x);
    }
    assert.ok(furthest > 100, "it went past the edge");
    assert.ok(axisAtRest(axis, -100, 100));
    close(axis.x, 100, 0.6);
});
