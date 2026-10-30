// Module Web Worker: hue channel (once per image) and connected-component
// labelling (per reference color / tolerance), off the UI thread.
import { computeHueChannel, hueMatchLut, INELIGIBLE, labelComponents, markBoundaries } from "./waterMask.ts";
import type { MaskRequest, MaskResponse } from "./maskProtocol.ts";

interface WorkerScope {
    postMessage(message: MaskResponse, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<MaskRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

let imageId: number | null = null;
let width = 0;
let height = 0;
let hue: Uint8Array | null = null;
/** Flood-fill stack, reused between runs (labelComponents grows it on demand). */
let stack: Int32Array | null = null;
/** A stack grown beyond this many entries (16 MB) is dropped after the run instead of kept. */
const STACK_KEEP_MAX = 1 << 22;

function post(message: MaskResponse, transfer: Transferable[] = []) {
    scope.postMessage(message, transfer);
}

function release() {
    imageId = null;
    hue = null;
    stack = null;
    width = 0;
    height = 0;
}

scope.onmessage = (event) => {
    const msg = event.data;
    try {
        switch (msg.type) {
            case "clear":
                release();
                return;

            case "setImage": {
                release();
                const t0 = performance.now();
                const rgba = new Uint8Array(msg.rgba);
                const h = computeHueChannel(rgba, msg.width, msg.height);
                // msg.rgba goes out of scope here: the RGBA copy is not kept.
                let eligible = 0;
                for (let i = 0; i < h.length; i++) if (h[i] !== INELIGIBLE) eligible++;

                imageId = msg.imageId;
                width = msg.width;
                height = msg.height;
                hue = h;

                const copy = h.slice();
                post(
                    {
                        type: "imageReady",
                        imageId: msg.imageId,
                        width,
                        height,
                        hue: copy.buffer,
                        eligibleCount: eligible,
                        ms: performance.now() - t0,
                    },
                    [copy.buffer]
                );
                return;
            }

            case "segment": {
                if (msg.imageId !== imageId || !hue) {
                    post({ type: "error", imageId: msg.imageId, jobId: msg.jobId, message: "Image is not loaded in the worker" });
                    return;
                }
                const t0 = performance.now();
                const lut = hueMatchLut(msg.refHue, msg.tolerance);
                const result = labelComponents(hue, width, height, lut, stack ?? undefined);
                stack = result.stack.length <= STACK_KEEP_MAX ? result.stack : null;
                markBoundaries(result.labels, width, height);
                post(
                    {
                        type: "segmented",
                        imageId: msg.imageId,
                        jobId: msg.jobId,
                        refHue: msg.refHue,
                        tolerance: msg.tolerance,
                        labels: result.labels.buffer as ArrayBuffer,
                        areas: result.areas.buffer as ArrayBuffer,
                        ms: performance.now() - t0,
                    },
                    [result.labels.buffer as ArrayBuffer, result.areas.buffer as ArrayBuffer]
                );
                return;
            }
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ids =
            msg.type === "segment"
                ? { imageId: msg.imageId, jobId: msg.jobId }
                : msg.type === "setImage"
                  ? { imageId: msg.imageId, jobId: null }
                  : { imageId: null, jobId: null };
        if (msg.type === "setImage") release();
        post({ type: "error", ...ids, message });
    }
};
