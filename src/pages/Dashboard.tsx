import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import "../styles/global.css";
import "./dashboard.css";

import {
    baseName,
    cancelStitch,
    clearProject,
    deleteProject,
    errorMessage,
    exportConflicts,
    exportFiles,
    getProject,
    loadImageBytes,
    onStitchLog,
    openFlight,
    openRecent,
    pickFolder,
    pickImages,
    recentProjects,
    revealExportFolder,
    setProjectName,
    stageExportMask,
    stitchImages,
    STITCH_CANCELLED,
    type ExportKind,
    type FlightSummary,
    type PanoramaInfo,
    type ProjectState,
    type RecentProject,
    type StitchTarget,
} from "../lib/api.ts";
import {
    areaHectares,
    buildMask,
    buildOverlay,
    countSelectedPixels,
    countSelectedPixelsInRegion,
    INELIGIBLE,
    paintOutsideRegion,
    polygonArea,
    rasterizeLasso,
    REGION_INSIDE,
    selectableLabelAt,
    toggleLabel,
    type LabelId,
    type Point,
} from "../lib/waterMask.ts";
import { useWaterMask } from "../lib/useWaterMask.ts";
import {
    clampView,
    DEFAULT_PADDING,
    fitView,
    offsetRanges,
    resizeView,
    screenToImage,
    zoomAt,
    type Padding,
    type Size,
    type View,
} from "../lib/viewport.ts";
import {
    axisAtRest,
    interpolateView,
    releaseVelocity,
    resist,
    springProgress,
    stepAxis,
    type Axis,
} from "../lib/viewMotion.ts";
import CopyToClipboard from "../lib/CopyToClipboard.tsx";
import { maskIcon, onRadioKeys, prefersReducedMotion, usePresence } from "../lib/ui.ts";
import SettingsMenu from "./Settings.tsx";
import { useTranslation } from "../lib/useTranslations.ts";

import LogoIcon26px from "../assets/icons/logo-26px.svg";
import SettingsIcon21px from "../assets/icons/settings-21px.svg";
import EyedropperIcon21px from "../assets/icons/eyedropper-21px.svg";
import LassoIcon21px from "../assets/icons/lasso-21px.svg";
import Undo21px from "../assets/icons/undo-21px.svg";
import FolderOpen21px from "../assets/icons/folderopen-21px.svg";
import Download21px from "../assets/icons/download-21px.svg";
import StitchAgain21px from "../assets/icons/stitch-again-21px.svg";
import Trash21px from "../assets/icons/trash-21px.svg";
import Cancel21px from "../assets/icons/cancel-21px.svg";
import Close21px from "../assets/icons/close-21px.svg";
import ChevronDown21px from "../assets/icons/chevron-down-21px.svg";

const CLICK_MOVE_THRESHOLD = 4; // px; a press that moves less than this is a click
const LASSO_POINT_SPACING = 2; // px on screen between recorded lasso points
const LASSO_MIN_AREA = 4; // image px²; a smaller lasso is a slip, not an area
const LASSO_COLOR = "#DC2626"; // same red as the overlay outside the lasso (OVERLAY_OUTSIDE_EDGE)
const CLEAR_CONFIRM_MS = 3000;
const NOISE_DEBOUNCE_MS = 150;
const EMPTY_SET: ReadonlySet<LabelId> = new Set();
const MAX_UNDO = 100; // steps kept in the undo history
const MAX_PROJECT_NAME = 100; // characters, same limit as the backend

type StatusKind = "progress" | "error" | "warning" | "info";
interface Status {
    kind: StatusKind;
    text: string;
    /** A button next to the text, such as Show in Finder. */
    action?: { label: string; run: () => void };
}

interface DisplaySource {
    key: string;
    path: string;
    isPanorama: boolean;
}

interface FlightChoice {
    scanId: number;
    folder: string;
    flights: FlightSummary[];
}

interface DownloadItem {
    kind: ExportKind;
    label: string;
    /** Why it cannot be saved now, or null when it can. */
    reason: string | null;
    /** Something to know before saving it. */
    note?: string;
}

interface LoadedImage {
    key: string;
    width: number;
    height: number;
    /** Image id in the mask worker, 0 when the pixels could not be read. */
    maskImageId: number;
}

interface Lasso {
    /** Display key of the image it was drawn on. */
    key: string;
    points: Point[];
}

/** Water patches clicked away, for the segmentation with this key (see segKey). */
interface Deselection {
    segKey: string | null;
    labels: ReadonlySet<LabelId>;
}

/** What one undo step puts back. */
interface MeasureState {
    refHue: number | null;
    tolerance: number;
    lasso: Lasso | null;
    deselection: Deselection;
}

/** The same image, colour and tolerance always give the same labels, so a deselection
 *  stays valid when an undo brings those settings back. */
function segKey(seg: { imageId: number; refHue: number; tolerance: number }): string {
    return `${seg.imageId}|${seg.refHue}|${seg.tolerance}`;
}

interface DragState {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    dragging: boolean;
    /** The press draws a lasso instead of panning. */
    lasso: boolean;
    /** Offset the pointer has pulled the image to, before the resistance past the limits. */
    rawX: number;
    rawY: number;
    /** Recent pointer positions, for the speed at release. */
    samples: { t: number; x: number; y: number }[];
}

/** Minimal shape of WebKit's non-standard GestureEvent (trackpad pinch). */
interface PinchGestureEvent extends Event {
    scale: number;
    clientX: number;
    clientY: number;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((x) => set.has(x));
}

function isPanoramaStale(state: ProjectState): boolean {
    return !!state.panorama && !sameSet(state.panorama.images, state.images);
}

function mosaicOf(state: ProjectState | null, target: StitchTarget): PanoramaInfo | null {
    return (target === "world" ? state?.worldPanorama : state?.panorama) ?? null;
}

/** The world mosaic as it can be saved: stitched from the current world photos. */
function worldMosaic(state: ProjectState | null): PanoramaInfo | null {
    const world = state?.worldPanorama;
    return world && sameSet(world.images, state.worldImages) ? world : null;
}

/** Closes an open menu on a press outside it and on Escape. */
function useDismiss(
    open: boolean,
    menuRef: RefObject<HTMLElement | null>,
    canvasRef: RefObject<HTMLCanvasElement | null>,
    close: () => void
) {
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: PointerEvent) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            close();
            // this press only closes the menu; it must not also select water
            if (e.target === canvasRef.current) e.stopPropagation();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("keydown", onKey);
        };
    }, [open, menuRef, canvasRef, close]);
}

/** An icon button's icon, drawn in the button's text colour. */
function Icon({ src }: { src: string }) {
    return <span className="icon-mask" style={maskIcon(src)} aria-hidden="true" />;
}

/** The × in the corner of every pop-up. */
function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button type="button" className="close-button" onClick={onClick} title={label} aria-label={label}>
            <span className="icon-mask" style={maskIcon(Close21px)} aria-hidden="true" />
        </button>
    );
}

function mimeFor(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "tif" || ext === "tiff") return "image/tiff";
    if (ext === "webp") return "image/webp";
    return "";
}

function readPixels(image: HTMLImageElement): ImageData {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    try {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2D canvas context available");
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
        // release the backing store right away
        canvas.width = 0;
        canvas.height = 0;
    }
}

/** Accepts a decimal comma or point, whatever the language. */
function parseGsd(text: string): number | null {
    const v = Number(text.trim().replace(",", "."));
    return text.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

function formatGsd(v: number, language: string): string {
    return Number(v.toPrecision(4)).toLocaleString(language, { useGrouping: false, maximumFractionDigits: 10 });
}

/** Width of a small number field: as wide as its text, so the unit sits right after it. */
function fieldWidth(text: string, placeholder: string): string {
    return `${Math.max(text.length, placeholder.length, 1) + 1}ch`;
}

const RADIO_VIEWS = ["thermal", "world"] as const;

const AREA_FORMAT: Intl.NumberFormatOptions = { minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false };

function Dashboard() {
    const mask = useWaterMask();
    const { t, language } = useTranslation();
    // For the image loading effect: a language change must not reload the image
    const tRef = useRef(t);
    tRef.current = t;

    // ---- refs for the canvas / view (not React state: they change every frame)
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const imageUrlRef = useRef<string | null>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayDataRef = useRef<ImageData | null>(null);
    /** The world mosaic on the frame of the panorama, once it has been looked at. */
    const worldImageRef = useRef<{ key: string; image: HTMLImageElement; url: string } | null>(null);
    const viewRef = useRef<View>({ scale: 1, offsetX: 0, offsetY: 0 });
    const viewportRef = useRef<Size>({ width: 0, height: 0 });
    const paddingRef = useRef<Padding>(DEFAULT_PADDING);
    const fitModeRef = useRef(true);
    const drawPendingRef = useRef(0);
    const dragRef = useRef<DragState | null>(null);
    const gestureRef = useRef<{ startScale: number; x: number; y: number } | null>(null);
    /** The running zoom, fit or glide animation (requestAnimationFrame id, 0 when none). */
    const motionFrameRef = useRef(0);
    /** Where the running zoom or fit animation ends, so a key press during it continues from there. */
    const motionTargetRef = useRef<View | null>(null);
    /** The lasso being drawn, in image coordinates (null when not drawing). */
    const lassoDraftRef = useRef<Point[] | null>(null);
    /** Display key whose worker crash was already retried once. */
    const crashRetryKeyRef = useRef<string | null>(null);

    // ---- project / stitching
    const [project, setProject] = useState<ProjectState | null>(null);
    const [localStitching, setLocalStitching] = useState(false);
    const stateSeqRef = useRef(0);
    const activeRunRef = useRef<number | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);
    const confirmTimerRef = useRef<number | null>(null);

    // ---- measuring
    const [loaded, setLoaded] = useState<LoadedImage | null>(null);
    const [imageLoading, setImageLoading] = useState(false);
    const [tolerance, setTolerance] = useState(1);
    const [noiseText, setNoiseText] = useState(""); // empty is 0
    const [noise, setNoise] = useState(0);
    const [picking, setPicking] = useState(true);
    const [lassoMode, setLassoMode] = useState(false);
    /** The area to measure in, for the image with this display key. */
    const [lasso, setLasso] = useState<Lasso | null>(null);
    const [refHue, setRefHue] = useState<number | null>(null);
    // Keyed by the segmentation's settings, so the labels of another segmentation are never applied.
    const [deselection, setDeselection] = useState<Deselection>({ segKey: null, labels: EMPTY_SET });
    /** Earlier measuring states, newest last. */
    const [history, setHistory] = useState<MeasureState[]>([]);
    /** Set while one slider drag (or key press) is changing the tolerance: it is one undo step. */
    const toleranceStepRef = useRef(false);
    const [gsdText, setGsdText] = useState("");
    const [gsdTouched, setGsdTouched] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [copied, setCopied] = useState(false);

    // ---- project name and downloads
    const [nameDraft, setNameDraft] = useState<string | null>(null); // non-null while editing
    const nameCancelledRef = useRef(false);
    const [downloadOpen, setDownloadOpen] = useState(false);
    const [replacePrompt, setReplacePrompt] = useState<{ kinds: ExportKind[]; files: string[] } | null>(null);
    const [exporting, setExporting] = useState(false);
    const downloadMenuRef = useRef<HTMLDivElement | null>(null);

    // ---- opening photos
    const [openMenu, setOpenMenu] = useState(false);
    const openMenuRef = useRef<HTMLDivElement | null>(null);
    const [flightChoice, setFlightChoice] = useState<FlightChoice | null>(null);

    // ---- settings (under the gear)
    const [settingsOpen, setSettingsOpen] = useState(false);
    const settingsMenuRef = useRef<HTMLDivElement | null>(null);

    // ---- recent projects (under the project name)
    const [recentOpen, setRecentOpen] = useState(false);
    const [recent, setRecent] = useState<RecentProject[] | null>(null); // null while loading
    /** The project whose delete button was clicked once and waits for the second click. */
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const deleteTimerRef = useRef<number | null>(null);
    const recentMenuRef = useRef<HTMLDivElement | null>(null);

    // ---- a notice that was closed stays closed until it says something else
    const [closedNotice, setClosedNotice] = useState<string | null>(null);

    // ---- world view (the RGB mosaic in place of the thermal panorama)
    const [worldOn, setWorldOn] = useState(false);
    const worldOnRef = useRef(worldOn);
    worldOnRef.current = worldOn;
    const [worldLoading, setWorldLoading] = useState(false);

    const segmentation = mask.segmentation;
    const deselected = segmentation && deselection.segKey === segKey(segmentation) ? deselection.labels : EMPTY_SET;

    // ---- undo
    const measureRef = useRef<MeasureState>({ refHue: null, tolerance: 1, lasso: null, deselection });
    measureRef.current = { refHue, tolerance, lasso, deselection };
    /** Call before a measuring change, so undo can put back what was there. */
    const recordUndo = useCallback(() => {
        const before = measureRef.current;
        setHistory((h) => [...h.slice(-(MAX_UNDO - 1)), before]);
    }, []);
    const undo = () => {
        const s = history[history.length - 1];
        if (!s) return;
        setHistory(history.slice(0, -1));
        lassoDraftRef.current = null;
        setLassoMode(false);
        setPicking(s.refHue === null);
        setRefHue(s.refHue);
        setTolerance(s.tolerance);
        setLasso(s.lasso);
        setDeselection(s.deselection);
    };
    const undoRef = useRef(undo);
    undoRef.current = undo;

    const stitching = localStitching || !!project?.stitching;
    const images = project?.images ?? [];
    const panorama = project?.panorama ?? null;
    const stale = !!project && isPanoramaStale(project);
    const thermalProject = project?.kind === "thermal";
    /** Thermal photos with RGB photos next to them: there is a world view to switch to. */
    const hasWorld = thermalProject && (project?.worldImages.length ?? 0) >= 2;
    const worldView = hasWorld ? (project?.worldView ?? null) : null;
    /** The world mosaic is stitched from the current photos but has no map coordinates:
     *  stitching it again would end the same way. */
    const worldOffMap = hasWorld && !worldView && worldMosaic(project)?.georeferenced === false;
    const worldKey = worldView ? `${worldView.path}|${worldView.mtimeMs}` : null;
    const worldPath = worldView?.path ?? null;

    const includedCount = useMemo(() => {
        if (!panorama) return 0;
        const included = new Set(panorama.includedImages);
        return images.filter((p) => included.has(p)).length;
    }, [panorama, images]);

    // What to show: the panorama if there is one, else the last image of the set.
    const displaySource: DisplaySource | null = panorama
        ? { key: `pano|${panorama.path}|${panorama.mtimeMs}`, path: panorama.path, isPanorama: true }
        : images.length > 0
          ? { key: `img|${images[images.length - 1]}`, path: images[images.length - 1], isPanorama: false }
          : null;
    const showingPanorama = !!displaySource?.isPanorama && !!panorama;
    const panoScale = showingPanorama ? panorama!.panoScale : 1;
    const estimatedGsd = showingPanorama ? panorama!.estimatedGsd : null;

    // ---- status helpers
    const clearStatus = useCallback(() => {
        setStatus(null);
        mask.clearError();
    }, [mask.clearError]);

    const showError = useCallback((text: string) => setStatus({ kind: "error", text }), []);

    // ---- project state, latest request wins (issue 9)
    const applyProject = useCallback((seq: number, state: ProjectState): boolean => {
        if (seq !== stateSeqRef.current) return false;
        setProject(state);
        return true;
    }, []);

    const refreshProject = useCallback(async () => {
        const seq = ++stateSeqRef.current;
        try {
            applyProject(seq, await getProject());
        } catch (err) {
            if (seq === stateSeqRef.current) showError(t("dashboard.loadProjectFailed", { error: errorMessage(err) }));
        }
    }, [applyProject, showError, t]);

    useEffect(() => {
        void refreshProject();
    }, [refreshProject]);

    // A stitch started before this page was (re)loaded: poll until it is done.
    useEffect(() => {
        if (!project?.stitching || localStitching) return;
        const timer = window.setInterval(() => void refreshProject(), 2000);
        return () => window.clearInterval(timer);
    }, [project?.stitching, localStitching, refreshProject]);

    // A stitch this page did not start (reload / back from Settings): show that it is running,
    // and when it ends without a new panorama say so (its error went to the old page).
    const prevBackendStitchingRef = useRef(false);
    const earlierStitchRef = useRef<{ target: StitchTarget; mtimeMs: number | null }>({ target: "primary", mtimeMs: null });
    useEffect(() => {
        const target = project?.stitching ?? null;
        const backendStitching = target !== null;
        const was = prevBackendStitchingRef.current;
        prevBackendStitchingRef.current = backendStitching;
        if (localStitching || activeRunRef.current !== null) return;
        if (target !== null) {
            if (!was) earlierStitchRef.current = { target, mtimeMs: mosaicOf(project, target)?.mtimeMs ?? null };
            setStatus((s) => s ?? { kind: "progress", text: t("dashboard.earlierStitch") });
        } else if (was) {
            const earlier = earlierStitchRef.current;
            const pano = mosaicOf(project, earlier.target);
            const finished = !!pano && pano.mtimeMs !== earlier.mtimeMs;
            // the world mosaic is started again from the World switch, not from Stitch again
            const failed = earlier.target === "world" ? "dashboard.earlierWorldStitchFailed" : "dashboard.earlierStitchFailed";
            setStatus((s) => (s?.kind === "progress" ? (finished ? null : { kind: "warning", text: t(failed) }) : s));
        }
    }, [project, localStitching, t]);

    // Progress lines from the stitcher, only for the run this page started.
    useEffect(() => {
        let disposed = false;
        let stop: (() => void) | null = null;
        onStitchLog(({ runId, line }) => {
            if (runId !== activeRunRef.current) return;
            const text = line.trim();
            if (text) setStatus({ kind: "progress", text });
        })
            .then((unlisten) => {
                if (disposed) unlisten();
                else stop = unlisten;
            })
            .catch((err) => console.error("Could not listen for stitch progress", err));
        return () => {
            disposed = true;
            stop?.();
        };
    }, []);

    const resetGsd = useCallback(() => {
        setGsdText("");
        setGsdTouched(false);
    }, []);

    const cancelClearConfirm = useCallback(() => {
        if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
        setConfirmClear(false);
    }, []);

    useEffect(() => () => {
        if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    }, []);

    /** Resolves to the new project state, or null when the stitch did not produce one. */
    const runStitch = useCallback(
        async (target: StitchTarget = "primary"): Promise<ProjectState | null> => {
            if (activeRunRef.current !== null) return null;
            const runId = Date.now();
            activeRunRef.current = runId;
            setLocalStitching(true);
            setStatus({ kind: "progress", text: t("dashboard.startingStitcher") });
            const seq = ++stateSeqRef.current;
            try {
                const state = await stitchImages(runId, target);
                activeRunRef.current = null; // drop late log lines
                // another request (a rename, say) answered meanwhile, with older news
                if (!applyProject(seq, state)) void refreshProject();
                setStatus((s) => (s?.kind === "progress" ? null : s));
                return state;
            } catch (err) {
                activeRunRef.current = null;
                const msg = errorMessage(err);
                if (msg === STITCH_CANCELLED) setStatus({ kind: "info", text: t("dashboard.stitchCancelled") });
                else setStatus({ kind: "error", text: /^stitching/i.test(msg) ? msg : t("dashboard.stitchFailed", { error: msg }) });
                void refreshProject();
                return null;
            } finally {
                setLocalStitching(false);
            }
        },
        [applyProject, refreshProject, t]
    );

    /** New photos were opened: start measuring afresh and stitch them. */
    const startProject = useCallback(
        (state: ProjectState) => {
            resetGsd();
            setWorldOn(false);
            const upToDate = !!state.panorama && !isPanoramaStale(state);
            if (state.images.length >= 2 && !upToDate && !state.stitching) void runStitch();
        },
        [resetGsd, runStitch]
    );

    /** Runs one way of opening photos; `open` resolves to null when nothing was opened. */
    const openWith = useCallback(
        async (open: () => Promise<ProjectState | null>) => {
            setOpenMenu(false);
            setRecentOpen(false);
            cancelClearConfirm();
            clearStatus();
            const seq = ++stateSeqRef.current;
            let state: ProjectState | null;
            try {
                state = await open();
            } catch (err) {
                if (seq === stateSeqRef.current) showError(errorMessage(err));
                return;
            }
            if (state !== null && applyProject(seq, state)) startProject(state);
        },
        [applyProject, cancelClearConfirm, clearStatus, showError, startProject]
    );

    const openPhotos = useCallback(() => openWith(() => pickImages()), [openWith]);

    const openFolder = useCallback(
        () =>
            openWith(async () => {
                const picked = await pickFolder();
                if (picked.outcome === "opened") return picked.state;
                // several flights in the folder: the user says which one
                setFlightChoice(picked.outcome === "chooseFlight" ? picked : null);
                return null;
            }),
        [openWith]
    );

    const chooseFlight = useCallback(
        (choice: FlightChoice, index: number) => {
            setFlightChoice(null);
            return openWith(() => openFlight(choice.scanId, index));
        },
        [openWith]
    );

    const toggleRecent = useCallback(() => {
        if (recentOpen) {
            setRecentOpen(false);
            cancelClearConfirm();
            return;
        }
        setRecentOpen(true);
        setRecent(null);
        setConfirmDelete(null);
        recentProjects().then(setRecent, (err) => {
            setRecentOpen(false);
            showError(t("dashboard.recentFailed", { error: errorMessage(err) }));
        });
    }, [recentOpen, cancelClearConfirm, showError, t]);

    /** First click arms the button, a second one within a few seconds deletes the project. */
    const deleteRecent = useCallback(
        async (id: string) => {
            if (deleteTimerRef.current !== null) window.clearTimeout(deleteTimerRef.current);
            deleteTimerRef.current = null;
            if (confirmDelete !== id) {
                setConfirmDelete(id);
                deleteTimerRef.current = window.setTimeout(() => {
                    deleteTimerRef.current = null;
                    setConfirmDelete(null);
                }, CLEAR_CONFIRM_MS);
                return;
            }
            setConfirmDelete(null);
            try {
                setRecent(await deleteProject(id));
            } catch (err) {
                showError(t("dashboard.deleteProjectFailed", { error: errorMessage(err) }));
            }
        },
        [confirmDelete, showError, t]
    );

    const pickRecent = useCallback(
        (id: string) => {
            cancelClearConfirm();
            return openWith(() => openRecent(id));
        },
        [cancelClearConfirm, openWith]
    );

    const onStitchAgain = useCallback(() => {
        cancelClearConfirm();
        clearStatus();
        void runStitch();
    }, [cancelClearConfirm, clearStatus, runStitch]);

    const onCancelStitch = useCallback(async () => {
        setStatus({ kind: "progress", text: t("dashboard.cancelling") });
        try {
            const killed = await cancelStitch();
            if (activeRunRef.current === null) {
                // not our run (or already finished): report and resync; keep an error or result
                // that arrived meanwhile
                if (killed) setStatus({ kind: "info", text: t("dashboard.stitchCancelled") });
                else setStatus((s) => (s?.kind === "progress" ? null : s));
                void refreshProject();
            }
        } catch (err) {
            showError(t("dashboard.cancelFailed", { error: errorMessage(err) }));
        }
    }, [refreshProject, showError, t]);

    const onClear = useCallback(async () => {
        if (!confirmClear) {
            setConfirmClear(true);
            confirmTimerRef.current = window.setTimeout(() => {
                confirmTimerRef.current = null;
                setConfirmClear(false);
            }, CLEAR_CONFIRM_MS);
            return;
        }
        cancelClearConfirm();
        clearStatus();
        setRecentOpen(false);
        const seq = ++stateSeqRef.current;
        try {
            const state = await clearProject();
            if (applyProject(seq, state)) {
                resetGsd();
                setWorldOn(false);
            }
        } catch (err) {
            if (seq === stateSeqRef.current) showError(errorMessage(err));
        }
    }, [applyProject, cancelClearConfirm, clearStatus, confirmClear, resetGsd, showError]);

    // ---- drawing (requestAnimationFrame, at most one frame pending)
    const draw = useCallback(() => {
        drawPendingRef.current = 0;
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        if (cssWidth === 0 || cssHeight === 0) return;

        const dpr = window.devicePixelRatio || 1;
        const bw = Math.round(cssWidth * dpr);
        const bh = Math.round(cssHeight * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const image = imageRef.current;
        if (!image) return;
        const v = viewRef.current;
        const w = image.naturalWidth * v.scale;
        const h = image.naturalHeight * v.scale;
        // The world mosaic covers the same piece of ground as the panorama, so it is drawn
        // in its place and everything else (the view, the mask, clicks) stays as it is.
        const world = worldOnRef.current ? worldImageRef.current?.image : null;
        const shown = world ?? image;
        // crisp pixels when zoomed in, smooth when zoomed out
        ctx.imageSmoothingEnabled = (w / shown.naturalWidth) * dpr < 2;
        ctx.drawImage(shown, v.offsetX, v.offsetY, w, h);
        ctx.imageSmoothingEnabled = v.scale * dpr < 2;

        const overlay = overlayCanvasRef.current;
        if (overlay && overlay.width === image.naturalWidth && overlay.height === image.naturalHeight) {
            ctx.drawImage(overlay, v.offsetX, v.offsetY, w, h);
        }

        const draft = lassoDraftRef.current;
        if (draft && draft.length > 1) {
            ctx.beginPath();
            for (const p of draft) ctx.lineTo(v.offsetX + p.x * v.scale, v.offsetY + p.y * v.scale);
            ctx.closePath();
            ctx.fillStyle = "rgba(220, 38, 38, 0.12)";
            ctx.fill("nonzero");
            ctx.strokeStyle = LASSO_COLOR;
            ctx.lineWidth = 2;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.stroke();
        }
    }, []);

    const requestDraw = useCallback(() => {
        if (drawPendingRef.current) return;
        drawPendingRef.current = requestAnimationFrame(draw);
    }, [draw]);

    useEffect(() => () => {
        if (drawPendingRef.current) cancelAnimationFrame(drawPendingRef.current);
        // reset, or requestDraw() would skip every later frame after a remount (StrictMode in dev)
        drawPendingRef.current = 0;
    }, []);

    const imageSize = (): Size | null => {
        const image = imageRef.current;
        return image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
    };

    // ---- motion: zoom and fit animate, a flick glides; any new input stops it where it is
    const stopMotion = useCallback(() => {
        if (motionFrameRef.current) cancelAnimationFrame(motionFrameRef.current);
        motionFrameRef.current = 0;
        motionTargetRef.current = null;
    }, []);
    useEffect(() => stopMotion, [stopMotion]);

    /** Animates from the view on screen now to `target` (critically damped, no overshoot). */
    const animateTo = useCallback(
        (target: View) => {
            stopMotion();
            if (prefersReducedMotion()) {
                viewRef.current = target;
                requestDraw();
                return;
            }
            const from = viewRef.current;
            const start = performance.now();
            motionTargetRef.current = target;
            const frame = (now: number) => {
                const p = springProgress((now - start) / 1000);
                const done = p > 0.999;
                viewRef.current = done ? target : interpolateView(from, target, p);
                draw();
                if (done) {
                    motionFrameRef.current = 0;
                    motionTargetRef.current = null;
                } else motionFrameRef.current = requestAnimationFrame(frame);
            };
            motionFrameRef.current = requestAnimationFrame(frame);
        },
        [draw, requestDraw, stopMotion]
    );

    /** After a pan: coast with the pointer's speed, then settle inside the limits. */
    const glide = useCallback(
        (velocity: { x: number; y: number }) => {
            stopMotion();
            const size = imageSize();
            if (!size) return;
            const limits = () => offsetRanges(viewRef.current, size, viewportRef.current, paddingRef.current);
            const v = prefersReducedMotion() ? { x: 0, y: 0 } : velocity;
            let ax: Axis = { x: viewRef.current.offsetX, v: v.x };
            let ay: Axis = { x: viewRef.current.offsetY, v: v.y };
            let last = performance.now();
            const frame = (now: number) => {
                const dt = Math.min(0.05, (now - last) / 1000);
                last = now;
                const r = limits();
                ax = stepAxis(ax, dt, r.x.lo, r.x.hi);
                ay = stepAxis(ay, dt, r.y.lo, r.y.hi);
                const rest = axisAtRest(ax, r.x.lo, r.x.hi) && axisAtRest(ay, r.y.lo, r.y.hi);
                const x = rest ? Math.min(r.x.hi, Math.max(r.x.lo, ax.x)) : ax.x;
                const y = rest ? Math.min(r.y.hi, Math.max(r.y.lo, ay.x)) : ay.x;
                viewRef.current = { ...viewRef.current, offsetX: x, offsetY: y };
                draw();
                motionFrameRef.current = rest ? 0 : requestAnimationFrame(frame);
            };
            motionFrameRef.current = requestAnimationFrame(frame);
        },
        [draw, stopMotion]
    );

    /** Fits the whole image in view; animated for a key press, instant otherwise. */
    const fit = useCallback(
        (animated = false) => {
            const image = imageRef.current;
            const vp = viewportRef.current;
            if (!image || vp.width === 0) return;
            const target = fitView({ width: image.naturalWidth, height: image.naturalHeight }, vp, paddingRef.current);
            fitModeRef.current = true;
            if (animated) animateTo(target);
            else {
                stopMotion();
                viewRef.current = target;
                requestDraw();
            }
        },
        [animateTo, requestDraw, stopMotion]
    );

    /** Zooms about (x, y), the centre by default. Wheel and pinch follow the fingers 1:1;
     *  key presses animate, each from where the previous one is heading. */
    const zoomBy = useCallback(
        (factor: number, x?: number, y?: number, animated = false) => {
            const image = imageRef.current;
            const vp = viewportRef.current;
            if (!image || vp.width === 0) return;
            const base = (animated && motionTargetRef.current) || viewRef.current;
            const target = zoomAt(
                base,
                factor,
                x ?? vp.width / 2,
                y ?? vp.height / 2,
                { width: image.naturalWidth, height: image.naturalHeight },
                vp,
                paddingRef.current
            );
            fitModeRef.current = false;
            if (animated) animateTo(target);
            else {
                stopMotion();
                viewRef.current = target;
                requestDraw();
            }
        },
        [animateTo, requestDraw, stopMotion]
    );

    // Keep the view sensible when the window resizes.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(() => {
            const next = { width: container.clientWidth, height: container.clientHeight };
            const prev = viewportRef.current;
            viewportRef.current = next;
            const size = imageSize();
            if (size && next.width > 0 && next.height > 0) {
                stopMotion();
                if (fitModeRef.current || prev.width === 0 || prev.height === 0) {
                    viewRef.current = fitView(size, next, paddingRef.current);
                } else {
                    viewRef.current = resizeView(viewRef.current, prev, next, size, paddingRef.current);
                }
            }
            requestDraw();
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [requestDraw, stopMotion]);

    // ---- image loading: bytes from Rust -> Blob -> object URL (same origin, canvas never tainted)
    const displayKey = displaySource?.key ?? null;
    const displayPath = displaySource?.path ?? null;
    const { clearImage, setImage: sendPixelsToWorker } = mask;

    useEffect(() => {
        // new source: forget the old measurement
        crashRetryKeyRef.current = null;
        setRefHue(null);
        setPicking(true);
        setLassoMode(false);
        setLasso(null);
        lassoDraftRef.current = null;
        setHistory([]); // the steps belong to the old image
        clearImage();
        const overlay = overlayCanvasRef.current;
        if (overlay) {
            overlay.width = 0;
            overlay.height = 0;
        }
        overlayDataRef.current = null;

        if (!displayKey || !displayPath) {
            imageRef.current = null;
            if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
            imageUrlRef.current = null;
            setLoaded(null);
            setImageLoading(false);
            requestDraw();
            return;
        }

        let cancelled = false;
        setImageLoading(true);
        (async () => {
            let url: string | null = null;
            try {
                const bytes = await loadImageBytes(displayPath);
                if (cancelled) return;
                url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(displayPath) }));
                const image = new Image();
                image.decoding = "async";
                image.src = url;
                try {
                    await image.decode();
                } catch {
                    throw new Error(tRef.current("dashboard.decodeFailed"));
                }
                if (cancelled) return;
                if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error(tRef.current("dashboard.imageEmpty"));

                // swap in the new image
                if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
                imageUrlRef.current = url;
                url = null;
                imageRef.current = image;
                stopMotion();
                const size = { width: image.naturalWidth, height: image.naturalHeight };
                if (viewportRef.current.width > 0) viewRef.current = fitView(size, viewportRef.current, paddingRef.current);
                fitModeRef.current = true;
                requestDraw();

                let maskImageId = 0;
                try {
                    maskImageId = sendPixelsToWorker(readPixels(image));
                } catch (err) {
                    setStatus({
                        kind: "error",
                        text: tRef.current("dashboard.readPixelsFailed", { error: errorMessage(err) }),
                    });
                }
                setLoaded({ key: displayKey, ...size, maskImageId });
            } catch (err) {
                if (cancelled) return;
                imageRef.current = null;
                // nothing can show the previous image any more: free its (possibly large) blob
                if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
                imageUrlRef.current = null;
                setLoaded(null);
                requestDraw();
                setStatus({
                    kind: "error",
                    text: tRef.current("dashboard.openFailed", { name: baseName(displayPath), error: errorMessage(err) }),
                });
            } finally {
                if (url) URL.revokeObjectURL(url); // created but not used
                if (!cancelled) setImageLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [displayKey, displayPath, clearImage, sendPixelsToWorker, requestDraw, stopMotion]);

    // Revoke the object URLs when leaving the page.
    useEffect(() => () => {
        if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
        imageRef.current = null;
        if (worldImageRef.current) URL.revokeObjectURL(worldImageRef.current.url);
        worldImageRef.current = null;
    }, []);

    // ---- world view: loaded the first time it is looked at, kept while it stays the same
    useEffect(() => {
        const held = worldImageRef.current;
        if (held && held.key !== worldKey) {
            // the mosaic it showed was replaced or removed
            URL.revokeObjectURL(held.url);
            worldImageRef.current = null;
        }
        requestDraw();
        if (!worldOn || !worldKey || !worldPath || worldImageRef.current) return;

        let cancelled = false;
        setWorldLoading(true);
        (async () => {
            let url: string | null = null;
            try {
                const bytes = await loadImageBytes(worldPath);
                if (cancelled) return;
                url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(worldPath) }));
                const image = new Image();
                image.decoding = "async";
                image.src = url;
                try {
                    await image.decode();
                } catch {
                    throw new Error(tRef.current("dashboard.decodeFailed"));
                }
                if (cancelled) return;
                worldImageRef.current = { key: worldKey, image, url };
                url = null;
                requestDraw();
            } catch (err) {
                if (cancelled) return;
                setWorldOn(false);
                setStatus({ kind: "error", text: tRef.current("dashboard.worldOpenFailed", { error: errorMessage(err) }) });
            } finally {
                if (url) URL.revokeObjectURL(url); // created but not used
                if (!cancelled) setWorldLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            setWorldLoading(false);
        };
    }, [worldOn, worldKey, worldPath, requestDraw]);

    // The world view with no world mosaic to show (its stitch failed or was cancelled, or
    // the panorama was stitched again): back to the thermal view.
    useEffect(() => {
        if (worldOn && !worldKey && !stitching) setWorldOn(false);
    }, [worldOn, worldKey, stitching]);

    const showWorld = async () => {
        setWorldOn(true);
        const state = worldView ? project : await runStitch("world");
        if (!state) return; // runStitch reports its own failure or cancellation
        // stitched, but it cannot be laid over the panorama
        if (!state.worldView) setStatus({ kind: "warning", text: t("dashboard.worldNoView") });
        else if (state.worldPanorama && !state.worldPanorama.aligned)
            setStatus({ kind: "warning", text: t("dashboard.worldNotAligned") });
    };

    // ---- segmentation (in the worker, latest wins)
    const { requestSegmentation } = mask;
    useEffect(() => {
        requestSegmentation(refHue === null ? null : { refHue, tolerance });
    }, [refHue, tolerance, requestSegmentation]);

    // Debounced noise threshold.
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const v = parseInt(noiseText, 10);
            setNoise(Number.isFinite(v) && v >= 0 ? v : 0);
        }, NOISE_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [noiseText]);

    // The lasso as one byte per image pixel (inside / outside / outline).
    const lassoW = loaded && lasso && lasso.key === loaded.key ? loaded.width : 0;
    const lassoH = loaded && lasso && lasso.key === loaded.key ? loaded.height : 0;
    const lassoPoints = lassoW > 0 ? lasso!.points : null;
    const lassoSize = useMemo(() => (lassoW > 0 ? { width: lassoW, height: lassoH } : null), [lassoW, lassoH]);
    const region = useMemo(
        () => (lassoPoints && lassoSize ? rasterizeLasso(lassoPoints, lassoSize.width, lassoSize.height) : null),
        [lassoPoints, lassoSize]
    );
    // a lasso for another image does not apply (its key is compared too, in case the sizes match)
    const lassoRegion = region && loaded && loaded.key === displayKey ? region : null;

    // Overlay: rebuilt from labels only when segmentation / noise / deselection / lasso change.
    useEffect(() => {
        if (!overlayCanvasRef.current) overlayCanvasRef.current = document.createElement("canvas");
        const overlay = overlayCanvasRef.current;
        const size = segmentation ?? (lassoRegion ? lassoSize : null);
        if (!size) {
            if (overlay.width !== 0) {
                overlay.width = 0;
                overlay.height = 0;
            }
            overlayDataRef.current = null;
            requestDraw();
            return;
        }
        const { width, height } = size;
        let data = overlayDataRef.current;
        if (!data || data.width !== width || data.height !== height) {
            data = new ImageData(width, height);
            overlayDataRef.current = data;
        }
        const pixels = new Uint32Array(data.data.buffer);
        if (segmentation) buildOverlay(segmentation.labels, segmentation.areas, noise, deselected, pixels);
        else pixels.fill(0);
        if (lassoRegion && lassoRegion.length === width * height) paintOutsideRegion(lassoRegion, pixels);
        if (overlay.width !== width || overlay.height !== height) {
            overlay.width = width;
            overlay.height = height;
        }
        const octx = overlay.getContext("2d");
        if (octx) {
            octx.putImageData(data, 0, 0);
            const image = imageRef.current;
            if (lassoRegion && image && image.naturalWidth === width && image.naturalHeight === height) {
                // only where the image has pixels: the empty corners of a mosaic stay clear, as for the water
                octx.globalCompositeOperation = "destination-in";
                octx.drawImage(image, 0, 0);
                octx.globalCompositeOperation = "source-over";
            }
        }
        requestDraw();
    }, [segmentation, lassoRegion, lassoSize, noise, deselected, requestDraw]);

    // Worker errors go to the status bar.
    useEffect(() => {
        if (mask.error) setStatus({ kind: "error", text: mask.error });
    }, [mask.error]);

    // ---- area (O(labels))
    const pixelCount = useMemo(() => {
        if (!segmentation) return null;
        if (lassoRegion && lassoRegion.length === segmentation.labels.length) {
            return countSelectedPixelsInRegion(segmentation.labels, segmentation.areas, noise, deselected, lassoRegion);
        }
        return countSelectedPixels(segmentation.areas, noise, deselected);
    }, [segmentation, noise, deselected, lassoRegion]);

    const gsd = gsdTouched ? parseGsd(gsdText) : estimatedGsd;
    const gsdIsEstimate = !gsdTouched && estimatedGsd !== null;
    const gsdInputValue = gsdTouched ? gsdText : estimatedGsd !== null ? formatGsd(estimatedGsd, language) : "";
    const area = pixelCount === null ? null : areaHectares(pixelCount, gsd, panoScale);

    const current = loaded && loaded.key === displayKey ? loaded : null;
    const analysisReady =
        !!current && current.maskImageId !== 0 && mask.hueInfo?.imageId === current.maskImageId;
    const analysisCrashed =
        !!current && current.maskImageId !== 0 && mask.crashedImageId === current.maskImageId;

    // The worker crashed on the current image: send the pixels again, but only once per
    // loaded image (a deterministic out-of-memory would otherwise crash-loop).
    useEffect(() => {
        const image = imageRef.current;
        if (!analysisCrashed || !current || !image || crashRetryKeyRef.current === current.key) return;
        crashRetryKeyRef.current = current.key;
        try {
            const maskImageId = sendPixelsToWorker(readPixels(image));
            setLoaded({ ...current, maskImageId });
            if (refHue !== null) requestSegmentation({ refHue, tolerance });
            setStatus({ kind: "info", text: t("dashboard.analysisRestarted") });
        } catch {
            // stays "Measuring unavailable"
        }
    }, [analysisCrashed, current, refHue, tolerance, sendPixelsToWorker, requestSegmentation, t]);

    // The top bar shows only the result; what to do next is a hint on the canvas.
    let areaValue: string;
    if (copied && area !== null) areaValue = t("dashboard.copied");
    else if (area !== null) areaValue = `${area.toLocaleString(language, AREA_FORMAT)} ha`;
    else if (pixelCount !== null) areaValue = t("dashboard.pixelsEnterGsd", { pixels: pixelCount.toLocaleString(language) });
    else areaValue = t("dashboard.areaNone");

    let hint: string | null = null;
    if (!displaySource || imageLoading || (current && mask.analysing)) hint = null; // empty state or busy pill
    else if (!current) hint = t("dashboard.imageUnavailable");
    else if (current.maskImageId === 0 || analysisCrashed) hint = t("dashboard.measuringUnavailable");
    else if (lassoMode) hint = t("dashboard.drawLasso");
    else if (picking) hint = t("dashboard.clickWater");
    else if (refHue === null) hint = t("dashboard.pickReferenceColour");

    const scaleUnverified = showingPanorama && !panorama!.gpsAligned;

    const onAreaClick = useCallback(() => {
        if (area === null) return;
        CopyToClipboard(area).then(
            () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            },
            (err) => showError(t("dashboard.copyFailed", { error: errorMessage(err) }))
        );
    }, [area, showError, t]);

    // ---- project name
    const commitName = async () => {
        const name = nameDraft;
        setNameDraft(null);
        if (nameCancelledRef.current) {
            nameCancelledRef.current = false;
            return;
        }
        if (name === null || name.trim() === (project?.name ?? "")) return;
        const seq = ++stateSeqRef.current;
        try {
            applyProject(seq, await setProjectName(name));
        } catch (err) {
            if (seq === stateSeqRef.current) showError(errorMessage(err));
        }
    };

    // ---- downloads
    const closeDownload = useCallback(() => setDownloadOpen(false), []);
    const openDownload = useCallback(() => {
        setReplacePrompt(null);
        setDownloadOpen(true);
    }, []);
    useDismiss(downloadOpen, downloadMenuRef, canvasRef, closeDownload);

    const closeOpenMenu = useCallback(() => setOpenMenu(false), []);
    useDismiss(openMenu, openMenuRef, canvasRef, closeOpenMenu);

    const closeRecent = useCallback(() => {
        setRecentOpen(false);
        cancelClearConfirm();
    }, [cancelClearConfirm]);
    useDismiss(recentOpen, recentMenuRef, canvasRef, closeRecent);

    const closeSettings = useCallback(() => setSettingsOpen(false), []);
    useDismiss(settingsOpen, settingsMenuRef, canvasRef, closeSettings);

    const downloadPresence = usePresence(downloadOpen);
    const openPresence = usePresence(openMenu);
    const recentPresence = usePresence(recentOpen);
    const settingsPresence = usePresence(settingsOpen);

    // The world mosaic of a thermal project is stitched when it is first asked for.
    const worldToStitch = hasWorld && !worldMosaic(project);
    // What is saved is what is selected when the files are written, which can be minutes
    // after the click when the world mosaic has to be stitched first.
    const measuredRef = useRef({
        segmentation,
        noise,
        deselected,
        region: lassoRegion,
        area,
        panoramaMtimeMs: panorama?.mtimeMs ?? null,
    });
    measuredRef.current = {
        segmentation,
        noise,
        deselected,
        region: lassoRegion,
        area,
        panoramaMtimeMs: panorama?.mtimeMs ?? null,
    };

    const saveFiles = async (kinds: ExportKind[]) => {
        closeDownload();
        // runStitch reports its own failure or cancellation
        if (kinds.includes("world") && worldToStitch && !(await runStitch("world"))) return;
        setExporting(true);
        setStatus({ kind: "progress", text: t("dashboard.exportSaving") });
        try {
            const measured = measuredRef.current;
            if (kinds.includes("polygon")) {
                if (!measured.segmentation) throw new Error(t("dashboard.exportNeedsWater"));
                const { labels, areas, width, height } = measured.segmentation;
                const waterMask = new Uint8Array(width * height);
                const region = measured.region && measured.region.length === waterMask.length ? measured.region : null;
                buildMask(labels, areas, measured.noise, measured.deselected, waterMask, region);
                await stageExportMask(waterMask);
            }
            const result = await exportFiles({
                kinds,
                areaHectares: measured.area,
                panoramaMtimeMs: measured.panoramaMtimeMs,
            });
            setStatus({
                kind: "info",
                text: t("dashboard.exportSaved", { folder: result.folder }),
                action: {
                    label: t("dashboard.showInFinder"),
                    run: () =>
                        void revealExportFolder().catch((err) =>
                            showError(t("dashboard.revealFailed", { error: errorMessage(err) }))
                        ),
                },
            });
        } catch (err) {
            setStatus({ kind: "error", text: t("dashboard.exportFailed", { error: errorMessage(err) }) });
        } finally {
            setExporting(false);
        }
    };

    const startDownload = async (kinds: ExportKind[]) => {
        try {
            const files = await exportConflicts(kinds);
            if (files.length > 0) setReplacePrompt({ kinds, files });
            else await saveFiles(kinds);
        } catch (err) {
            closeDownload();
            showError(t("dashboard.exportFailed", { error: errorMessage(err) }));
        }
    };

    const needsRestitch = showingPanorama && panorama!.gpsAligned && !panorama!.georeferenced;
    const mapReason =
        showingPanorama && panorama!.georeferenced
            ? null
            : needsRestitch
              ? t("dashboard.exportNeedsStitch")
              : t("dashboard.exportNoGps");
    const waterReason = analysisReady && pixelCount !== null && pixelCount > 0 ? null : t("dashboard.exportNeedsWater");
    const downloadItems: DownloadItem[] = [
        ...(thermalProject ? [{ kind: "thermal" as const, label: t("dashboard.downloadThermal"), reason: mapReason }] : []),
        // without thermal photos the RGB panorama is the world orthomosaic
        ...(hasWorld || !thermalProject
            ? [
                  {
                      kind: "world" as const,
                      label: t("dashboard.downloadWorld"),
                      reason: mapReason ?? (worldOffMap ? t("dashboard.worldNoView") : null),
                      note: worldToStitch ? t("dashboard.worldStitchFirst") : undefined,
                  },
              ]
            : []),
        { kind: "polygon", label: t("dashboard.downloadPolygon"), reason: mapReason ?? waterReason },
        {
            kind: "area",
            label: t("dashboard.downloadArea"),
            reason: area !== null ? null : pixelCount === null ? t("dashboard.exportNeedsWater") : t("dashboard.exportNeedsGsd"),
        },
    ];

    // ---- canvas interaction
    const handleCanvasClick = (x: number, y: number) => {
        const info = mask.hueInfo;
        if (!imageRef.current || !current) return;
        if (!analysisReady || !info) {
            if (analysisCrashed) setStatus({ kind: "error", text: t("dashboard.analysisCrashed") });
            else if (current.maskImageId !== 0) setStatus({ kind: "info", text: t("dashboard.stillAnalysing") });
            return;
        }
        const p = screenToImage(viewRef.current, x, y);
        if (p.x < 0 || p.y < 0 || p.x >= info.width || p.y >= info.height) return;

        if (picking) {
            const hue = info.hue[p.y * info.width + p.x];
            if (hue === INELIGIBLE) {
                setStatus({ kind: "warning", text: t("dashboard.noColour") });
                return;
            }
            setStatus((s) => (s && s.kind !== "progress" ? null : s));
            if (hue !== refHue) recordUndo();
            setRefHue(hue);
            setPicking(false);
        } else if (segmentation) {
            // water outside the lasso is not measured, so there is nothing to (de)select there
            if (lassoRegion && lassoRegion[p.y * info.width + p.x] !== REGION_INSIDE) return;
            const label = selectableLabelAt(
                segmentation.labels,
                segmentation.areas,
                segmentation.width,
                segmentation.height,
                p.x,
                p.y,
                noise
            );
            if (label !== null) {
                recordUndo();
                setDeselection({ segKey: segKey(segmentation), labels: toggleLabel(deselected, label) });
            }
        }
    };
    const handleCanvasClickRef = useRef(handleCanvasClick);
    handleCanvasClickRef.current = handleCanvasClick;

    const localPoint = (clientX: number, clientY: number) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const lassoPointAt = (clientX: number, clientY: number): Point => {
        const p = localPoint(clientX, clientY);
        const v = viewRef.current;
        return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.button !== 0 || e.ctrlKey) return; // ctrl-click is a context click on macOS
        e.currentTarget.setPointerCapture(e.pointerId);
        // grabbing the image mid-glide stops it right there
        stopMotion();
        const lassoPress = lassoMode && !!current;
        lassoDraftRef.current = lassoPress ? [lassoPointAt(e.clientX, e.clientY)] : null;
        dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            dragging: false,
            lasso: lassoPress,
            rawX: viewRef.current.offsetX,
            rawY: viewRef.current.offsetY,
            samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
        };
    };

    /** Ends a lasso press: a drag sets the area to measure, a click removes it. */
    const finishLasso = (d: DragState, completed: boolean) => {
        const draft = lassoDraftRef.current;
        lassoDraftRef.current = null;
        requestDraw();
        if (!completed || !displayKey) return;
        if (!d.dragging) {
            if (lassoRegion) recordUndo();
            setLasso(null);
            setLassoMode(false);
        } else if (draft && draft.length >= 3 && polygonArea(draft) >= LASSO_MIN_AREA) {
            recordUndo();
            setLasso({ key: displayKey, points: draft });
            setLassoMode(false);
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
            // the button was released where we did not see it (pointerup lost): end the drag
            dragRef.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            if (d.lasso) finishLasso(d, true);
            else if (d.dragging) {
                setDragging(false);
                glide({ x: 0, y: 0 });
            }
            return;
        }
        if (d.lasso) {
            if (!d.dragging && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= CLICK_MOVE_THRESHOLD) {
                d.dragging = true;
            }
            if (Math.hypot(e.clientX - d.lastX, e.clientY - d.lastY) < LASSO_POINT_SPACING) return;
            lassoDraftRef.current?.push(lassoPointAt(e.clientX, e.clientY));
            d.lastX = e.clientX;
            d.lastY = e.clientY;
            requestDraw();
            return;
        }
        if (!d.dragging) {
            if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_MOVE_THRESHOLD) return;
            d.dragging = true;
            setDragging(true);
        }
        // 1:1 with the pointer inside the limits, with growing resistance past them
        d.rawX += e.clientX - d.lastX;
        d.rawY += e.clientY - d.lastY;
        d.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
        if (d.samples.length > 8) d.samples.shift();
        const size = imageSize();
        if (size) {
            const vp = viewportRef.current;
            const r = offsetRanges(viewRef.current, size, vp, paddingRef.current);
            viewRef.current = {
                ...viewRef.current,
                offsetX: resist(d.rawX, r.x.lo, r.x.hi, vp.width),
                offsetY: resist(d.rawY, r.y.lo, r.y.hi, vp.height),
            };
            fitModeRef.current = false;
            requestDraw();
        }
        d.lastX = e.clientX;
        d.lastY = e.clientY;
    };

    const endPointer = (e: React.PointerEvent<HTMLCanvasElement>, isClick: boolean) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        dragRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        if (d.lasso) finishLasso(d, isClick);
        else if (d.dragging) {
            setDragging(false);
            // keep the flick's speed; a cancelled pointer only settles back inside the limits
            glide(isClick ? releaseVelocity(d.samples, e.timeStamp) : { x: 0, y: 0 });
        } else if (isClick) {
            const p = localPoint(e.clientX, e.clientY);
            handleCanvasClickRef.current(p.x, p.y);
        }
    };

    // Wheel and pinch zoom (native listeners: React's onWheel is passive).
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const onWheel = (e: WheelEvent) => {
            if (!imageRef.current) return;
            e.preventDefault();
            if (gestureRef.current) return; // WebKit pinch is handled by gesture events
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewportRef.current.height || 800 : 1;
            const dx = e.deltaX * unit;
            const dy = e.deltaY * unit;
            if (e.ctrlKey || e.metaKey) {
                // a trackpad pinch arrives as ctrl+wheel; ⌘+wheel zooms with a mouse
                const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
                const p = localPoint(e.clientX, e.clientY);
                zoomBy(Math.min(2, Math.max(0.5, factor)), p.x, p.y);
                return;
            }
            // two-finger scroll pans, like Maps; the system's own momentum keeps it gliding
            stopMotion();
            const image = imageRef.current;
            viewRef.current = clampView(
                { ...viewRef.current, offsetX: viewRef.current.offsetX - dx, offsetY: viewRef.current.offsetY - dy },
                { width: image.naturalWidth, height: image.naturalHeight },
                viewportRef.current,
                paddingRef.current
            );
            fitModeRef.current = false;
            requestDraw();
        };
        const onGestureStart = (e: Event) => {
            e.preventDefault();
            const g = e as PinchGestureEvent;
            const p = localPoint(g.clientX, g.clientY);
            gestureRef.current = { startScale: viewRef.current.scale, x: p.x, y: p.y };
        };
        const onGestureChange = (e: Event) => {
            e.preventDefault();
            const g = gestureRef.current;
            if (!g || !imageRef.current) return;
            const target = g.startScale * (e as PinchGestureEvent).scale;
            zoomBy(target / viewRef.current.scale, g.x, g.y);
        };
        const onGestureEnd = (e: Event) => {
            e.preventDefault();
            gestureRef.current = null;
        };

        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("gesturestart", onGestureStart);
        canvas.addEventListener("gesturechange", onGestureChange);
        canvas.addEventListener("gestureend", onGestureEnd);
        return () => {
            canvas.removeEventListener("wheel", onWheel);
            canvas.removeEventListener("gesturestart", onGestureStart);
            canvas.removeEventListener("gesturechange", onGestureChange);
            canvas.removeEventListener("gestureend", onGestureEnd);
        };
    }, [zoomBy, stopMotion, requestDraw]);

    // Keyboard: 0 = fit, +/- = zoom, Escape = leave picking mode, Alt+Tab = Thermal/Photo.
    const toggleViewRef = useRef(() => {});
    const refHueRef = useRef(refHue);
    refHueRef.current = refHue;
    const lassoModeRef = useRef(lassoMode);
    lassoModeRef.current = lassoMode;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            // text fields keep their own undo; the slider is an input too, but has no text
            const typing =
                !!t && (t.tagName === "TEXTAREA" || t.isContentEditable || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range"));
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
                if (typing) return;
                e.preventDefault();
                undoRef.current();
                return;
            }
            if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === "Tab") {
                e.preventDefault();
                toggleViewRef.current();
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            if (e.key === "0") fit(true);
            else if (e.key === "+" || e.key === "=") zoomBy(1.25, undefined, undefined, true);
            else if (e.key === "-" || e.key === "_") zoomBy(0.8, undefined, undefined, true);
            else if (e.key === "Escape" && lassoModeRef.current) {
                lassoDraftRef.current = null;
                setLassoMode(false);
                requestDraw();
            } else if (e.key === "Escape" && refHueRef.current !== null) setPicking(false);
            else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [fit, zoomBy, requestDraw]);

    const canvasCursor = dragging
        ? "grabbing"
        : !current
          ? "default"
          : picking || lassoMode
            ? "crosshair"
            : segmentation
              ? "pointer"
              : "grab";

    const busyText = imageLoading
        ? t("dashboard.loadingImage")
        : worldLoading
          ? t("dashboard.loadingWorld")
          : mask.analysing
          ? t("dashboard.analysingImage")
          : mask.segmenting
            ? t("dashboard.findingWater")
            : null;

    const showStitchAgain = !stitching && !exporting && images.length >= 2 && (!panorama || stale || needsRestitch);

    const projectNameText = nameDraft ?? project?.name ?? "";

    const fullNotice = !panorama
        ? null
        : stale
          ? {
                kind: "warning" as const,
                text: t("dashboard.panoramaStale", { included: includedCount, total: images.length }),
            }
          : panorama.includedImages.length < panorama.images.length
            ? {
                  kind: "info" as const,
                  text: t("dashboard.partialPanorama", { included: panorama.includedImages.length, total: panorama.images.length }),
              }
            : null;
    // closed for this panorama and these photos; a change brings it back
    const noticeKey = fullNotice ? `${fullNotice.kind}|${panorama!.path}|${panorama!.mtimeMs}|${images.length}` : null;
    const notice = noticeKey !== closedNotice ? fullNotice : null;

    const hasClearable = images.length > 0 || !!panorama;
    // a stitch or export in progress; a click would interrupt it
    const busy = stitching || exporting;

    const worldDisabled =
        !showingPanorama || !current || !panorama!.georeferenced || worldOffMap || (!worldView && (stitching || exporting));
    const viewValue = worldOn ? "world" : "thermal";
    const pickView = (view: (typeof RADIO_VIEWS)[number]) => (view === "world" ? void showWorld() : setWorldOn(false));
    // same rules as the toggle: no switch without a photo view, nor to a disabled one
    toggleViewRef.current = () => {
        if (hasWorld && (worldOn || !worldDisabled)) pickView(worldOn ? "thermal" : "world");
    };

    return (
        <div>
            <div className="nav">
                <div className="brand-and-breadcrumb">
                    <div className="brand">
                        <img src={LogoIcon26px} alt="" />
                    </div>

                    <h1>Terra</h1>

                    <div className="spacer"></div>

                    <div className="project-switcher" ref={recentMenuRef}>
                        <input
                            className="project-name"
                            type="text"
                            spellCheck={false}
                            maxLength={MAX_PROJECT_NAME}
                            value={projectNameText}
                            placeholder={t("dashboard.untitled")}
                            aria-label={t("dashboard.projectName")}
                            title={t("dashboard.projectNameHint")}
                            style={{ width: `${Math.max(projectNameText.length, t("dashboard.untitled").length) + 2}ch` }}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                                else if (e.key === "Escape") {
                                    nameCancelledRef.current = true;
                                    e.currentTarget.blur();
                                }
                            }}
                            onBlur={() => void commitName()}
                        />
                        <button
                            type="button"
                            className={`recent-toggle${recentOpen ? " open" : ""}`}
                            onClick={toggleRecent}
                            disabled={busy}
                            title={t("dashboard.projectMenu")}
                            aria-label={t("dashboard.projectMenu")}
                            aria-expanded={recentOpen}
                        >
                            <Icon src={ChevronDown21px} />
                        </button>
                        {recentPresence.mounted && (
                            <div
                                className={`recent-popover popover${recentPresence.closing ? " popover-exit" : ""}`}
                                role="dialog"
                                aria-label={t("dashboard.projectMenu")}
                            >
                                <div className="popover-header">{t("dashboard.recentProjects")}</div>
                                {recent === null ? (
                                    <p className="recent-message">
                                        <span className="spinner" aria-hidden="true" />
                                    </p>
                                ) : recent.length === 0 ? (
                                    <p className="recent-message">{t("dashboard.recentEmpty")}</p>
                                ) : (
                                    <div className="recent-list">
                                        {recent.map((item) => (
                                            <div key={item.id} className="recent-row">
                                                <button className="download-item" onClick={() => void pickRecent(item.id)}>
                                                    <span className="recent-name">{item.name ?? t("dashboard.untitled")}</span>
                                                    <small>
                                                        {[
                                                            t("dashboard.recentPhotos", { count: item.images }),
                                                            item.openedAtMs > 0
                                                                ? new Date(item.openedAtMs).toLocaleString(language, {
                                                                      dateStyle: "medium",
                                                                      timeStyle: "short",
                                                                  })
                                                                : null,
                                                            item.hasPanorama ? null : t("dashboard.recentNotStitched"),
                                                        ]
                                                            .filter(Boolean)
                                                            .join(" · ")}
                                                    </small>
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`recent-delete${confirmDelete === item.id ? " confirm" : ""}`}
                                                    onClick={() => void deleteRecent(item.id)}
                                                    title={
                                                        confirmDelete === item.id
                                                            ? t("dashboard.deleteProjectConfirmHint")
                                                            : t("dashboard.deleteProject")
                                                    }
                                                    aria-label={t("dashboard.deleteProject")}
                                                >
                                                    <Icon src={Trash21px} />
                                                    {confirmDelete === item.id && <span>{t("dashboard.deleteProjectConfirm")}</span>}
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="download-divider" />
                                <button
                                    type="button"
                                    className={`download-item danger${confirmClear ? " confirm" : ""}`}
                                    disabled={!hasClearable || busy}
                                    onClick={() => void onClear()}
                                >
                                    {confirmClear ? t("dashboard.clearProjectConfirm") : t("dashboard.clearProject")}
                                    <small>{t("dashboard.clearProjectHint")}</small>
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="system-actions">
                    <label className="noise" title={t("dashboard.noiseHint")}>
                        <span className="field-label">{t("dashboard.noiseLabel")}</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            placeholder="0"
                            value={noiseText}
                            aria-label={t("dashboard.noiseLabel")}
                            style={{ width: fieldWidth(noiseText, "0") }}
                            onChange={(e) => setNoiseText(e.target.value.replace(/\D/g, ""))}
                        />
                        <span className="unit">px</span>
                    </label>
                    <label className="gsd" title={t("dashboard.gsdHint")}>
                        <span className="field-label">GSD</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="—"
                            value={gsdInputValue}
                            aria-label={t("dashboard.gsdHint")}
                            style={{ width: fieldWidth(gsdInputValue, "—") }}
                            onChange={(e) => {
                                setGsdText(e.target.value.replace(/[^\d.,]/g, ""));
                                setGsdTouched(true);
                            }}
                            onBlur={(e) => {
                                // leaving the field empty falls back to the GPS estimate (if any)
                                if (e.target.value.trim() === "") resetGsd();
                            }}
                        />
                        <span className="unit">m/px</span>
                        {gsdIsEstimate && (
                            <span className="gsd-estimate" title={t("dashboard.estimatedFromGps")}>
                                {t("dashboard.estimateShort")}
                            </span>
                        )}
                    </label>
                    <button
                        type="button"
                        className="area"
                        onClick={onAreaClick}
                        disabled={area === null}
                        title={area !== null ? t("dashboard.copyAreaHint") : undefined}
                        aria-live="polite"
                    >
                        <span className="area-label">{t("dashboard.area")}</span>
                        <strong className="area-value">{areaValue}</strong>
                        {scaleUnverified && (
                            <span
                                className="area-warning"
                                title={t("dashboard.scaleUnverified")}
                                aria-label={t("dashboard.scaleUnverified")}
                            >
                                !
                            </span>
                        )}
                    </button>

                    <div className="right-system-actions">
                        <div className="open-menu" ref={openMenuRef}>
                            <button
                                type="button"
                                className={openMenu ? "open" : undefined}
                                onClick={() => setOpenMenu((open) => !open)}
                                disabled={busy}
                                title={t("dashboard.openImagesHint")}
                                aria-label={t("dashboard.openImages")}
                                aria-expanded={openMenu}
                            >
                                <Icon src={FolderOpen21px} />
                            </button>
                            {openPresence.mounted && (
                                <div className={`open-popover popover${openPresence.closing ? " popover-exit" : ""}`}>
                                    <button className="download-item" onClick={() => void openFolder()}>
                                        {t("dashboard.openFolder")}
                                        <small>{t("dashboard.openFolderHint")}</small>
                                    </button>
                                    <button className="download-item" onClick={() => void openPhotos()}>
                                        {t("dashboard.choosePhotos")}
                                        <small>{t("dashboard.choosePhotosHint")}</small>
                                    </button>
                                </div>
                            )}
                        </div>
                        {showStitchAgain && (
                            <button
                                type="button"
                                onClick={onStitchAgain}
                                title={t("dashboard.stitchAgainHint")}
                                aria-label={t("dashboard.stitchAgain")}
                            >
                                <Icon src={StitchAgain21px} />
                            </button>
                        )}
                        {stitching && (
                            <button
                                type="button"
                                onClick={() => void onCancelStitch()}
                                title={t("dashboard.cancelStitching")}
                                aria-label={t("dashboard.cancelStitching")}
                            >
                                <Icon src={Cancel21px} />
                            </button>
                        )}
                        <div className="settings-menu" ref={settingsMenuRef}>
                            <button
                                type="button"
                                className={settingsOpen ? "open" : undefined}
                                onClick={() => setSettingsOpen((open) => !open)}
                                title={t("settings.title")}
                                aria-label={t("settings.title")}
                                aria-expanded={settingsOpen}
                            >
                                <Icon src={SettingsIcon21px} />
                            </button>
                            {settingsPresence.mounted && <SettingsMenu closing={settingsPresence.closing} />}
                        </div>
                    </div>
                </div>
            </div>

            <div className="content-dashboard" ref={containerRef}>
                <canvas
                    className="background"
                    ref={canvasRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={(e) => endPointer(e, true)}
                    onPointerCancel={(e) => endPointer(e, false)}
                    onLostPointerCapture={(e) => endPointer(e, false)}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{ cursor: canvasCursor }}
                />

                {!displaySource && !flightChoice && (
                    <div className="empty-state">
                        <h3>{t("dashboard.noImagesTitle")}</h3>
                        <p>{t("dashboard.noImagesText")}</p>
                        <button className="primary" onClick={() => void openFolder()} disabled={stitching}>
                            <Icon src={FolderOpen21px} />
                            {t("dashboard.openFolder")}
                        </button>
                        <button className="link" onClick={() => void openPhotos()} disabled={stitching}>
                            {t("dashboard.choosePhotos")}
                        </button>
                    </div>
                )}

                {flightChoice && (
                    <div className="flight-chooser" role="dialog" aria-label={t("dashboard.chooseFlightTitle")}>
                        <div className="dialog-header">
                            <h3>{t("dashboard.chooseFlightTitle")}</h3>
                            <CloseButton label={t("dashboard.dismiss")} onClick={() => setFlightChoice(null)} />
                        </div>
                        <p>{t("dashboard.chooseFlightText", { folder: flightChoice.folder, count: flightChoice.flights.length })}</p>
                        <div className="flight-list">
                            {flightChoice.flights.map((flight, index) => (
                                <button
                                    key={flight.label}
                                    className="download-item"
                                    onClick={() => void chooseFlight(flightChoice, index)}
                                >
                                    {flight.label}
                                    <small>
                                        {[
                                            flight.thermal > 0 ? t("dashboard.flightThermal", { count: flight.thermal }) : null,
                                            flight.world > 0 ? t("dashboard.flightWorld", { count: flight.world }) : null,
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </small>
                                </button>
                            ))}
                        </div>
                        <button className="cancel" onClick={() => setFlightChoice(null)}>
                            {t("dashboard.exportCancel")}
                        </button>
                    </div>
                )}

                {(notice || status || hint) && (
                    <div className="top-stack">
                        {notice && (
                            <div className={`notice ${notice.kind}`} title={notice.text}>
                                <span className="text">{notice.text}</span>
                                <CloseButton label={t("dashboard.dismiss")} onClick={() => setClosedNotice(noticeKey)} />
                            </div>
                        )}
                        {status && (
                            <div className={`status-bar ${status.kind}`} title={status.text} role="status">
                                {status.kind === "progress" && <span className="spinner" aria-hidden="true" />}
                                <span className="text">{status.text}</span>
                                {status.action && (
                                    <button type="button" className="status-action" onClick={status.action.run}>
                                        {status.action.label}
                                    </button>
                                )}
                                {status.kind !== "progress" && <CloseButton label={t("dashboard.dismiss")} onClick={clearStatus} />}
                            </div>
                        )}
                        {!status && hint && (
                            <div className="hint" role="status">
                                {hint}
                            </div>
                        )}
                    </div>
                )}

                {displaySource && (
                    <div className="controls">
                        {hasWorld && (
                            <div
                                className="view-toggle"
                                role="radiogroup"
                                aria-label={t("dashboard.viewToggle")}
                                data-active={viewValue}
                                onKeyDown={(e) =>
                                    onRadioKeys(e, RADIO_VIEWS, viewValue, (v) => v === "thermal" || !worldDisabled, pickView)
                                }
                            >
                                <button
                                    type="button"
                                    className="view-toggle-option"
                                    role="radio"
                                    aria-checked={!worldOn}
                                    tabIndex={worldOn ? -1 : 0}
                                    onClick={() => setWorldOn(false)}
                                >
                                    {t("dashboard.viewThermal")}
                                </button>
                                <button
                                    type="button"
                                    className="view-toggle-option"
                                    role="radio"
                                    aria-checked={worldOn}
                                    tabIndex={worldOn ? 0 : -1}
                                    disabled={worldDisabled}
                                    title={
                                        worldView
                                            ? undefined
                                            : showingPanorama && !panorama!.georeferenced
                                              ? t("dashboard.worldNeedsMap")
                                              : worldOffMap
                                                ? t("dashboard.worldNoView")
                                                : t("dashboard.worldStitchFirst")
                                    }
                                    onClick={() => void showWorld()}
                                >
                                    {t("dashboard.viewWorld")}
                                </button>
                                <span className="view-toggle-thumb" aria-hidden="true"></span>
                            </div>
                        )}
                        <div className="tool-group" role="group" aria-label={t("dashboard.tools")}>
                            <button
                                type="button"
                                className={`tool-button${picking ? " active" : ""}`}
                                aria-pressed={picking}
                                aria-label={t("dashboard.colourPicker")}
                                title={t("dashboard.newColourHint")}
                                onClick={() => {
                                    if (!picking) setLassoMode(false);
                                    setPicking(!picking);
                                }}
                            >
                                <Icon src={EyedropperIcon21px} />
                            </button>
                            <button
                                type="button"
                                className={`tool-button${lassoMode ? " active" : ""}`}
                                aria-pressed={lassoMode}
                                aria-label={t("dashboard.lasso")}
                                title={t("dashboard.lassoHint")}
                                onClick={() => {
                                    if (!lassoMode) setPicking(false);
                                    setLassoMode(!lassoMode);
                                }}
                            >
                                <Icon src={LassoIcon21px} />
                            </button>
                            <span className="tool-divider" aria-hidden="true" />
                            <button
                                type="button"
                                className="tool-button"
                                disabled={history.length === 0}
                                aria-label={t("dashboard.undo")}
                                title={t("dashboard.undoHint")}
                                onClick={undo}
                            >
                                <Icon src={Undo21px} />
                            </button>
                        </div>
                        <div className="slider-container" title={t("dashboard.toleranceHint")}>
                            <input
                                type="range"
                                min="1"
                                max="50"
                                step="1"
                                className="slider"
                                aria-label={t("dashboard.tolerance")}
                                value={tolerance}
                                onChange={(e) => {
                                    // one drag (or one key press) is one undo step
                                    if (!toleranceStepRef.current) recordUndo();
                                    toleranceStepRef.current = true;
                                    setTolerance(Number(e.target.value));
                                }}
                                onPointerUp={() => (toleranceStepRef.current = false)}
                                onKeyUp={() => (toleranceStepRef.current = false)}
                                onBlur={() => (toleranceStepRef.current = false)}
                            />
                        </div>
                        <div className="download-menu" ref={downloadMenuRef}>
                            {downloadPresence.mounted && (
                                <div className={`download-popover popover${downloadPresence.closing ? " popover-exit" : ""}`}>
                                    {replacePrompt ? (
                                        <div className="download-confirm">
                                            <p>{t("dashboard.exportReplaceTitle")}</p>
                                            <ul>
                                                {replacePrompt.files.map((file) => (
                                                    <li key={file} title={file}>
                                                        {file}
                                                    </li>
                                                ))}
                                            </ul>
                                            <div className="download-confirm-actions">
                                                <button onClick={() => setReplacePrompt(null)}>{t("dashboard.exportCancel")}</button>
                                                <button className="replace" onClick={() => void saveFiles(replacePrompt.kinds)}>
                                                    {t("dashboard.exportReplace")}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="popover-header">{t("dashboard.exportFolder")}</div>
                                            {downloadItems.map(({ kind, label, reason, note }) => (
                                                <button
                                                    key={kind}
                                                    className="download-item"
                                                    disabled={reason !== null}
                                                    onClick={() => void startDownload([kind])}
                                                >
                                                    {label}
                                                    {(reason ?? note) && <small>{reason ?? note}</small>}
                                                </button>
                                            ))}
                                            <div className="download-divider" />
                                            <button
                                                className="download-item all"
                                                disabled={downloadItems.some((item) => item.reason !== null)}
                                                onClick={() => void startDownload(downloadItems.map((item) => item.kind))}
                                            >
                                                {t("dashboard.downloadAll")}
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                            <button
                                type="button"
                                className={`download-button${downloadOpen ? " open" : ""}`}
                                onClick={() => (downloadOpen ? closeDownload() : openDownload())}
                                disabled={!current || busy}
                                title={t("dashboard.downloadHint")}
                                aria-label={t("dashboard.download")}
                                aria-expanded={downloadOpen}
                            >
                                <Icon src={Download21px} />
                            </button>
                        </div>
                    </div>
                )}

                {/* outside the centred controls row, so the slider never moves while dragging */}
                {busyText && (
                    <div className="busy" role="status">
                        <span className="spinner" aria-hidden="true" />
                        {busyText}
                    </div>
                )}
            </div>
        </div>
    );
}

export default Dashboard;
