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
}

export interface ProjectState {
    /** Null until the user names the project. */
    name: string | null;
    images: string[];
    panorama: PanoramaInfo | null;
    stitching: boolean;
}

export type PickMode = "replace" | "add";

export interface StitchLogPayload {
    runId: number;
    line: string;
}

export const getProject = (): Promise<ProjectState> => invoke<ProjectState>("get_project");

/** Opens the native file dialog (from Rust). Resolves null when the dialog is cancelled. */
export const pickImages = (mode: PickMode): Promise<ProjectState | null> =>
    invoke<ProjectState | null>("pick_images", { mode });

export const clearProject = (): Promise<ProjectState> => invoke<ProjectState>("clear_project");

export const stitchImages = (runId: number): Promise<ProjectState> => invoke<ProjectState>("stitch_images", { runId });

/** True when a running stitch was killed. */
export const cancelStitch = (): Promise<boolean> => invoke<boolean>("cancel_stitch");

/** Raw file bytes of an image in the current set or of the current panorama. */
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

export type ExportKind = "orthomosaic" | "polygon" | "area";

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
