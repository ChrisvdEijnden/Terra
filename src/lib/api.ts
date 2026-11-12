// Typed wrappers around the Rust commands and the stitch-log event.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PanoramaInfo {
    path: string;
    mtimeMs: number;
    width: number;
    height: number;
    /** Images the panorama was stitched from (input order). */
    images: string[];
    /** Images that actually ended up in the panorama. */
    includedImages: string[];
    gpsAligned: boolean;
    /** Metres per full-resolution source-image pixel, from GPS (only when gpsAligned). */
    estimatedGsd: number | null;
    /** Panorama pixels per full-resolution source-image pixel. */
    panoScale: number | null;
    /** True when the panorama can be placed on a map. */
    georeferenced: boolean;
    /** World mosaic: its photos were lined up with the thermal panorama. False when they are
     *  placed by their own GPS (or without the camera offset) and may be a few metres off. */
    aligned: boolean;
}

/** The camera a set of photos came from; "world" is visible light (RGB). */
export type PhotoKind = "thermal" | "world";

/** The panorama that is measured on, or the world mosaic that goes with a thermal one. */
export type StitchTarget = "primary" | "world";

/** The world mosaic on the frame of the panorama, to draw in its place. */
export interface WorldView {
    path: string;
    mtimeMs: number;
}

export interface ProjectState {
    /** Null until the user names the project. */
    name: string | null;
    /** The photos that are measured on. */
    images: string[];
    /** What `images` are. */
    kind: PhotoKind;
    /** The RGB photos that go with thermal `images`. */
    worldImages: string[];
    panorama: PanoramaInfo | null;
    worldPanorama: PanoramaInfo | null;
    /** Null until the world mosaic is stitched for this panorama and these photos. */
    worldView: WorldView | null;
    /** The mosaic that is being stitched right now, if any. */
    stitching: StitchTarget | null;
}

export type PickMode = "replace" | "add";

/** One flight in a picked folder, with its number of photos per camera. */
export interface FlightSummary {
    label: string;
    thermal: number;
    world: number;
}

export type OpenOutcome =
    | { outcome: "cancelled" }
    | { outcome: "opened"; state: ProjectState }
    | { outcome: "chooseFlight"; scanId: number; folder: string; flights: FlightSummary[] };

export interface StitchLogPayload {
    runId: number;
    line: string;
}

export const getProject = (): Promise<ProjectState> => invoke<ProjectState>("get_project");

/** Opens the native file dialog (from Rust). Resolves null when the dialog is cancelled. */
export const pickImages = (mode: PickMode): Promise<ProjectState | null> =>
    invoke<ProjectState | null>("pick_images", { mode });

/**
 * Opens the native folder dialog (from Rust) and makes a project of the photos in the
 * picked folder, sorted into thermal and world ones.
 */
export const pickFolder = (): Promise<OpenOutcome> => invoke<OpenOutcome>("pick_folder");

/** Opens one of the flights pickFolder found. */
export const openFlight = (scanId: number, index: number): Promise<ProjectState> =>
    invoke<ProjectState>("open_flight", { scanId, index });

export const clearProject = (): Promise<ProjectState> => invoke<ProjectState>("clear_project");

export const stitchImages = (runId: number, target: StitchTarget = "primary"): Promise<ProjectState> =>
    invoke<ProjectState>("stitch_images", { runId, target });

/** True when a running stitch was killed. */
export const cancelStitch = (): Promise<boolean> => invoke<boolean>("cancel_stitch");

/** Raw file bytes of an image in the current set, of the current panorama or of the world view. */
export async function loadImageBytes(path: string): Promise<ArrayBuffer> {
    const r: unknown = await invoke("load_image", { path });
    if (r instanceof ArrayBuffer) return r;
    // Tauri's postMessage IPC fallback delivers raw bytes as a typed array or a JSON number array.
    if (ArrayBuffer.isView(r)) return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) as ArrayBuffer;
    if (Array.isArray(r)) return new Uint8Array(r).buffer;
    throw new Error("unexpected response from load_image");
}

export function onStitchLog(handler: (payload: StitchLogPayload) => void): Promise<UnlistenFn> {
    return listen<StitchLogPayload>("stitch-log", (event) => handler(event.payload));
}

/** Saves the name; the returned state holds it as it will be used in file names. */
export const setProjectName = (name: string): Promise<ProjectState> => invoke<ProjectState>("set_project_name", { name });

/** "thermal" and "world" are the orthomosaics of those photos. */
export type ExportKind = "thermal" | "world" | "polygon" | "area";

export interface ExportRequest {
    kinds: ExportKind[];
    /** The name to use while the project has none. */
    fallbackName: string;
    areaHectares: number | null;
    panoramaMtimeMs: number | null;
}

export interface ExportResult {
    /** For display, for example Documents/Terra/Polder. */
    folder: string;
    files: string[];
}

/** Names of the files an export would replace. */
export const exportConflicts = (kinds: ExportKind[], fallbackName: string): Promise<string[]> =>
    invoke<string[]>("export_conflicts", { kinds, fallbackName });

/** Hands over the water mask (one byte per panorama pixel) ahead of exportFiles. */
export const stageExportMask = (mask: Uint8Array): Promise<void> => invoke<void>("stage_export_mask", mask);

export const exportFiles = (request: ExportRequest): Promise<ExportResult> =>
    invoke<ExportResult>("export_files", { request });

export const STITCH_CANCELLED = "Stitching cancelled";

/** A single human-readable line from whatever a command rejected with. */
export function errorMessage(err: unknown): string {
    let text: string;
    if (typeof err === "string") text = err;
    else if (err instanceof Error) text = err.message;
    else if (err && typeof err === "object" && "message" in err) text = String((err as { message: unknown }).message);
    else text = String(err);
    const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "Something went wrong";
}

/** File name of a path, for display. */
export function baseName(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}
