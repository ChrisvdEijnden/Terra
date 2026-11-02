import { useNavigate } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "../styles/global.css";
import "./dashboard.css";

import {
    baseName,
    cancelStitch,
    clearProject,
    errorMessage,
    getProject,
    loadImageBytes,
    onStitchLog,
    pickImages,
    stitchImages,
    STITCH_CANCELLED,
    type PickMode,
    type ProjectState,
} from "../lib/api.ts";
import {
    areaHectares,
    buildOverlay,
    countSelectedPixels,
    INELIGIBLE,
    selectableLabelAt,
    toggleLabel,
    type LabelId,
} from "../lib/waterMask.ts";
import { useWaterMask } from "../lib/useWaterMask.ts";
import {
    clampView,
    DEFAULT_PADDING,
    fitView,
    panBy,
    resizeView,
    screenToImage,
    zoomAt,
    type Padding,
    type Size,
    type View,
} from "../lib/viewport.ts";
import CopyToClipboard from "../lib/CopyToClipboard.tsx";

import LogoIcon26px from "../assets/icons/logo-26px.svg";
import SettingsIcon21px from "../assets/icons/settings-21px.svg";
import EyedropperIcon21px from "../assets/icons/eyedropper-21px.svg";
import FolderOpen21px from "../assets/icons/folderopen-21px.svg";
import ImagePlus21px from "../assets/icons/image-plus-21px.svg";
import StitchAgain21px from "../assets/icons/stitch-again-21px.svg";
import Trash21px from "../assets/icons/trash-21px.svg";
import Cancel21px from "../assets/icons/cancel-21px.svg";
import Fit21px from "../assets/icons/fit-21px.svg";

const NO_COLOUR_MESSAGE =
    "That spot has no usable colour (no data, too grey or too dark). Click on the water.";
const CLICK_MOVE_THRESHOLD = 4; // px; a press that moves less than this is a click
const CLEAR_CONFIRM_MS = 3000;
const NOISE_DEBOUNCE_MS = 150;
const EARLIER_STITCH_MESSAGE = "Stitching (started earlier)…";
const EARLIER_STITCH_FAILED_MESSAGE = "The earlier stitch did not finish; click Stitch again";
const ANALYSIS_CRASHED_MESSAGE = "Image analysis stopped unexpectedly; measuring is unavailable for this image";
/** Keeps the top of the image clear of the persistent notice (top 12 + height 30 + gap 8). */
const NOTICE_PADDING: Padding = { ...DEFAULT_PADDING, top: 50 };
const EMPTY_SET: ReadonlySet<LabelId> = new Set();

type StatusKind = "progress" | "error" | "warning" | "info";
interface Status {
    kind: StatusKind;
    text: string;
}

interface DisplaySource {
    key: string;
    path: string;
    isPanorama: boolean;
}

interface LoadedImage {
    key: string;
    width: number;
    height: number;
    /** Image id in the mask worker, 0 when the pixels could not be read. */
    maskImageId: number;
}

interface DragState {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    dragging: boolean;
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

function mimeFor(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "tif" || ext === "tiff") return "image/tiff";
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

function parseGsd(text: string): number | null {
    const v = parseFloat(text);
    return Number.isFinite(v) && v > 0 ? v : null;
}

function formatGsd(v: number): string {
    return String(Number(v.toPrecision(4)));
}

const numberFormat = new Intl.NumberFormat();

function Dashboard() {
    const navigate = useNavigate();
    const mask = useWaterMask();

    // ---- refs for the canvas / view (not React state: they change every frame)
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const imageUrlRef = useRef<string | null>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayDataRef = useRef<ImageData | null>(null);
    const viewRef = useRef<View>({ scale: 1, offsetX: 0, offsetY: 0 });
    const viewportRef = useRef<Size>({ width: 0, height: 0 });
    const paddingRef = useRef<Padding>(DEFAULT_PADDING);
    const fitModeRef = useRef(true);
    const drawPendingRef = useRef(0);
    const dragRef = useRef<DragState | null>(null);
    const gestureRef = useRef<{ startScale: number; x: number; y: number } | null>(null);
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
    const [noiseText, setNoiseText] = useState("0");
    const [noise, setNoise] = useState(0);
    const [picking, setPicking] = useState(true);
    const [refHue, setRefHue] = useState<number | null>(null);
    // Keyed by the segmentation's job id, so an outdated segmentation (and its labels) is not kept alive.
    const [deselection, setDeselection] = useState<{ segId: number | null; labels: ReadonlySet<LabelId> }>({
        segId: null,
        labels: EMPTY_SET,
    });
    const [gsdText, setGsdText] = useState("");
    const [gsdTouched, setGsdTouched] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [copied, setCopied] = useState(false);

    const segmentation = mask.segmentation;
    const deselected = segmentation && deselection.segId === segmentation.jobId ? deselection.labels : EMPTY_SET;

    const stitching = localStitching || !!project?.stitching;
    const images = project?.images ?? [];
    const panorama = project?.panorama ?? null;
    const stale = !!project && isPanoramaStale(project);

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
            if (seq === stateSeqRef.current) showError(`Could not load the project: ${errorMessage(err)}`);
        }
    }, [applyProject, showError]);

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
    const earlierPanoMtimeRef = useRef<number | null>(null);
    useEffect(() => {
        const backendStitching = !!project?.stitching;
        const was = prevBackendStitchingRef.current;
        prevBackendStitchingRef.current = backendStitching;
        if (localStitching || activeRunRef.current !== null) return;
        if (backendStitching) {
            if (!was) earlierPanoMtimeRef.current = project?.panorama?.mtimeMs ?? null;
            setStatus((s) => s ?? { kind: "progress", text: EARLIER_STITCH_MESSAGE });
        } else if (was) {
            const pano = project?.panorama ?? null;
            const finished = !!pano && pano.mtimeMs !== earlierPanoMtimeRef.current;
            setStatus((s) =>
                s?.kind === "progress" ? (finished ? null : { kind: "warning", text: EARLIER_STITCH_FAILED_MESSAGE }) : s
            );
        }
    }, [project, localStitching]);

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

    const runStitch = useCallback(async () => {
        if (activeRunRef.current !== null) return;
        const runId = Date.now();
        activeRunRef.current = runId;
        setLocalStitching(true);
        setStatus({ kind: "progress", text: "Starting the stitcher…" });
        const seq = ++stateSeqRef.current;
        try {
            const state = await stitchImages(runId);
            activeRunRef.current = null; // drop late log lines
            applyProject(seq, state);
            setStatus((s) => (s?.kind === "progress" ? null : s));
        } catch (err) {
            activeRunRef.current = null;
            const msg = errorMessage(err);
            if (msg === STITCH_CANCELLED) setStatus({ kind: "info", text: STITCH_CANCELLED });
            else setStatus({ kind: "error", text: /^stitching/i.test(msg) ? msg : `Stitching failed: ${msg}` });
            void refreshProject();
        } finally {
            setLocalStitching(false);
        }
    }, [applyProject, refreshProject]);

    const pick = useCallback(
        async (mode: PickMode) => {
            cancelClearConfirm();
            clearStatus();
            const seq = ++stateSeqRef.current;
            let state: ProjectState | null;
            try {
                state = await pickImages(mode);
            } catch (err) {
                if (seq === stateSeqRef.current) showError(errorMessage(err));
                return;
            }
            if (state === null) return; // dialog cancelled
            if (!applyProject(seq, state)) return;
            if (mode === "replace") resetGsd();
            const upToDate = !!state.panorama && !isPanoramaStale(state);
            if (state.images.length >= 2 && !upToDate && !state.stitching) void runStitch();
        },
        [applyProject, cancelClearConfirm, clearStatus, resetGsd, runStitch, showError]
    );

    const onStitchAgain = useCallback(() => {
        cancelClearConfirm();
        clearStatus();
        void runStitch();
    }, [cancelClearConfirm, clearStatus, runStitch]);

    const onCancelStitch = useCallback(async () => {
        setStatus({ kind: "progress", text: "Cancelling…" });
        try {
            const killed = await cancelStitch();
            if (activeRunRef.current === null) {
                // not our run (or already finished): report and resync; keep an error or result
                // that arrived meanwhile
                if (killed) setStatus({ kind: "info", text: STITCH_CANCELLED });
                else setStatus((s) => (s?.kind === "progress" ? null : s));
                void refreshProject();
            }
        } catch (err) {
            showError(`Could not cancel: ${errorMessage(err)}`);
        }
    }, [refreshProject, showError]);

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
        const seq = ++stateSeqRef.current;
        try {
            const state = await clearProject();
            if (applyProject(seq, state)) resetGsd();
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
        // crisp pixels when zoomed in, smooth when zoomed out
        ctx.imageSmoothingEnabled = v.scale * dpr < 2;
        ctx.drawImage(image, v.offsetX, v.offsetY, w, h);

        const overlay = overlayCanvasRef.current;
        if (overlay && overlay.width === image.naturalWidth && overlay.height === image.naturalHeight) {
            ctx.drawImage(overlay, v.offsetX, v.offsetY, w, h);
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

    const fit = useCallback(() => {
        const image = imageRef.current;
        const vp = viewportRef.current;
        if (!image || vp.width === 0) return;
        viewRef.current = fitView({ width: image.naturalWidth, height: image.naturalHeight }, vp, paddingRef.current);
        fitModeRef.current = true;
        requestDraw();
    }, [requestDraw]);

    const zoomBy = useCallback(
        (factor: number, x?: number, y?: number) => {
            const image = imageRef.current;
            const vp = viewportRef.current;
            if (!image || vp.width === 0) return;
            viewRef.current = zoomAt(
                viewRef.current,
                factor,
                x ?? vp.width / 2,
                y ?? vp.height / 2,
                { width: image.naturalWidth, height: image.naturalHeight },
                vp,
                paddingRef.current
            );
            fitModeRef.current = false;
            requestDraw();
        },
        [requestDraw]
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
    }, [requestDraw]);

    // ---- image loading: bytes from Rust -> Blob -> object URL (same origin, canvas never tainted)
    const displayKey = displaySource?.key ?? null;
    const displayPath = displaySource?.path ?? null;
    const { clearImage, setImage: sendPixelsToWorker } = mask;

    useEffect(() => {
        // new source: forget the old measurement
        crashRetryKeyRef.current = null;
        setRefHue(null);
        setPicking(true);
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
                    throw new Error("the file could not be decoded as an image");
                }
                if (cancelled) return;
                if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error("the image is empty");

                // swap in the new image
                if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
                imageUrlRef.current = url;
                url = null;
                imageRef.current = image;
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
                        text: `Could not read the image pixels, measuring is unavailable: ${errorMessage(err)}`,
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
                setStatus({ kind: "error", text: `Could not open ${baseName(displayPath)}: ${errorMessage(err)}` });
            } finally {
                if (url) URL.revokeObjectURL(url); // created but not used
                if (!cancelled) setImageLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [displayKey, displayPath, clearImage, sendPixelsToWorker, requestDraw]);

    // Revoke the object URL when leaving the page.
    useEffect(() => () => {
        if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
        imageRef.current = null;
    }, []);

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

    // Overlay: rebuilt from labels only when segmentation / noise / deselection change.
    useEffect(() => {
        if (!overlayCanvasRef.current) overlayCanvasRef.current = document.createElement("canvas");
        const overlay = overlayCanvasRef.current;
        if (!segmentation) {
            if (overlay.width !== 0) {
                overlay.width = 0;
                overlay.height = 0;
            }
            overlayDataRef.current = null;
            requestDraw();
            return;
        }
        const { width, height } = segmentation;
        let data = overlayDataRef.current;
        if (!data || data.width !== width || data.height !== height) {
            data = new ImageData(width, height);
            overlayDataRef.current = data;
        }
        buildOverlay(segmentation.labels, segmentation.areas, noise, deselected, new Uint32Array(data.data.buffer));
        if (overlay.width !== width || overlay.height !== height) {
            overlay.width = width;
            overlay.height = height;
        }
        overlay.getContext("2d")?.putImageData(data, 0, 0);
        requestDraw();
    }, [segmentation, noise, deselected, requestDraw]);

    // Worker errors go to the status bar.
    useEffect(() => {
        if (mask.error) setStatus({ kind: "error", text: mask.error });
    }, [mask.error]);

    // ---- area (O(labels))
    const pixelCount = useMemo(
        () => (segmentation ? countSelectedPixels(segmentation.areas, noise, deselected) : null),
        [segmentation, noise, deselected]
    );

    const gsd = gsdTouched ? parseGsd(gsdText) : estimatedGsd;
    const gsdIsEstimate = !gsdTouched && estimatedGsd !== null;
    const gsdInputValue = gsdTouched ? gsdText : estimatedGsd !== null ? formatGsd(estimatedGsd) : "";
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
            setStatus({ kind: "info", text: "Image analysis stopped unexpectedly and was restarted" });
        } catch {
            // stays "Measuring unavailable"
        }
    }, [analysisCrashed, current, refHue, tolerance, sendPixelsToWorker, requestSegmentation]);

    let areaLabelText: string;
    if (!displaySource) areaLabelText = "Open images to start";
    else if (imageLoading || (current && mask.analysing)) areaLabelText = "Loading image…";
    else if (!current) areaLabelText = "Image unavailable";
    else if (current.maskImageId === 0 || analysisCrashed) areaLabelText = "Measuring unavailable";
    else if (picking) areaLabelText = "Click water to set the reference colour";
    else if (refHue === null) areaLabelText = "Pick a reference colour";
    else if (pixelCount === null) areaLabelText = "Finding water…";
    else if (area === null) areaLabelText = `${numberFormat.format(pixelCount)} px · enter the GSD`;
    else areaLabelText = `Area: ${area.toFixed(3)} ha`;
    if (copied && area !== null) areaLabelText = "Copied";

    const scaleUnverified = showingPanorama && !panorama!.gpsAligned;

    const onAreaClick = useCallback(() => {
        if (area === null) return;
        CopyToClipboard(area).then(
            () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            },
            (err) => showError(`Could not copy: ${errorMessage(err)}`)
        );
    }, [area, showError]);

    // ---- canvas interaction
    const handleCanvasClick = (x: number, y: number) => {
        const info = mask.hueInfo;
        if (!imageRef.current || !current) return;
        if (!analysisReady || !info) {
            if (analysisCrashed) setStatus({ kind: "error", text: ANALYSIS_CRASHED_MESSAGE });
            else if (current.maskImageId !== 0) setStatus({ kind: "info", text: "Still analysing the image…" });
            return;
        }
        const p = screenToImage(viewRef.current, x, y);
        if (p.x < 0 || p.y < 0 || p.x >= info.width || p.y >= info.height) return;

        if (picking) {
            const hue = info.hue[p.y * info.width + p.x];
            if (hue === INELIGIBLE) {
                setStatus({ kind: "warning", text: NO_COLOUR_MESSAGE });
                return;
            }
            setStatus((s) => (s && s.kind !== "progress" ? null : s));
            setRefHue(hue);
            setPicking(false);
        } else if (segmentation) {
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
                setDeselection({ segId: segmentation.jobId, labels: toggleLabel(deselected, label) });
            }
        }
    };
    const handleCanvasClickRef = useRef(handleCanvasClick);
    handleCanvasClickRef.current = handleCanvasClick;

    const localPoint = (clientX: number, clientY: number) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.button !== 0 || e.ctrlKey) return; // ctrl-click is a context click on macOS
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            dragging: false,
        };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
            // the button was released where we did not see it (pointerup lost): end the drag
            dragRef.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            if (d.dragging) setDragging(false);
            return;
        }
        if (!d.dragging) {
            if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < CLICK_MOVE_THRESHOLD) return;
            d.dragging = true;
            setDragging(true);
        }
        const size = imageSize();
        if (size) {
            viewRef.current = panBy(
                viewRef.current,
                e.clientX - d.lastX,
                e.clientY - d.lastY,
                size,
                viewportRef.current,
                paddingRef.current
            );
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
        if (d.dragging) setDragging(false);
        else if (isClick) {
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
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16;
            else if (e.deltaMode === 2) dy *= viewportRef.current.height || 800;
            const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
            const p = localPoint(e.clientX, e.clientY);
            zoomBy(Math.min(2, Math.max(0.5, factor)), p.x, p.y);
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
    }, [zoomBy]);

    // Keyboard: 0 = fit, +/- = zoom, Escape = leave picking mode.
    const refHueRef = useRef(refHue);
    refHueRef.current = refHue;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            if (e.key === "0") fit();
            else if (e.key === "+" || e.key === "=") zoomBy(1.25);
            else if (e.key === "-" || e.key === "_") zoomBy(0.8);
            else if (e.key === "Escape" && refHueRef.current !== null) setPicking(false);
            else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [fit, zoomBy]);

    const canvasCursor = dragging
        ? "grabbing"
        : !current
          ? "default"
          : picking
            ? "crosshair"
            : segmentation
              ? "pointer"
              : "grab";

    const busyText = imageLoading
        ? "Loading image…"
        : mask.analysing
          ? "Analysing image…"
          : mask.segmenting
            ? "Finding water…"
            : null;

    const showStitchAgain = !stitching && images.length >= 2 && (!panorama || stale);

    const notice = !panorama
        ? null
        : stale
          ? {
                kind: "warning" as const,
                text: `Panorama is out of date: built from ${includedCount} of ${images.length} images`,
            }
          : panorama.includedImages.length < panorama.images.length
            ? {
                  kind: "info" as const,
                  text: `${panorama.includedImages.length} of ${panorama.images.length} images could be stitched into the panorama`,
              }
            : null;

    // The notice cannot be dismissed, so the image is fitted and clamped below it.
    const padding = notice ? NOTICE_PADDING : DEFAULT_PADDING;
    paddingRef.current = padding;
    useEffect(() => {
        const size = imageSize();
        const vp = viewportRef.current;
        if (!size || vp.width === 0 || vp.height === 0) return;
        viewRef.current = fitModeRef.current
            ? fitView(size, vp, padding)
            : clampView(viewRef.current, size, vp, padding);
        requestDraw();
    }, [padding, requestDraw]);

    return (
        <div>
            <div className="nav">
                <div className="brand-and-breadcrumb">
                    <div className="brand">
                        <img src={LogoIcon26px} alt="PhysicsGo logo" />
                    </div>

                    <h1>Terra</h1>

                    <div className="spacer"></div>

                    <h2>Dashboard</h2>
                </div>

                <div className="system-actions">
                    <div className="noise" title="Ignore water patches smaller than this many panorama pixels">
                        <p>
                            Noise Threshold:{" "}
                            <input
                                type="number"
                                step="1"
                                min="0"
                                placeholder="0"
                                value={noiseText}
                                onChange={(e) => setNoiseText(e.target.value)}
                            />
                            px
                        </p>
                    </div>
                    <div className="gsd" title="Ground sampling distance: metres per pixel of one source photo">
                        <p>
                            GSD:{" "}
                            <input
                                type="number"
                                step="any"
                                min="0"
                                placeholder="0.0883"
                                value={gsdInputValue}
                                onChange={(e) => {
                                    setGsdText(e.target.value);
                                    setGsdTouched(true);
                                }}
                                onBlur={(e) => {
                                    // leaving the field empty falls back to the GPS estimate (if any)
                                    if (e.target.value.trim() === "") resetGsd();
                                }}
                            />
                            m/px
                            {gsdIsEstimate && (
                                <span className="gsd-estimate" title="Estimated from GPS">
                                    est.
                                </span>
                            )}
                        </p>
                    </div>
                    <div
                        className={`area${area !== null ? " copyable" : ""}`}
                        onClick={onAreaClick}
                        title={area !== null ? "Click to copy the area in hectares" : undefined}
                    >
                        <p>{areaLabelText}</p>
                        {scaleUnverified && (
                            <span
                                className="area-warning"
                                title="Scale not verified by GPS - check the GSD"
                                aria-label="Scale not verified by GPS - check the GSD"
                            >
                                !
                            </span>
                        )}
                    </div>

                    <div className="right-system-actions">
                        <button onClick={() => void pick("replace")} disabled={stitching} title="Open images (replaces the current set)">
                            <img src={FolderOpen21px} alt="Open images" />
                        </button>
                        <button onClick={() => void pick("add")} disabled={stitching} title="Add images to the current set">
                            <img src={ImagePlus21px} alt="Add images" />
                        </button>
                        {showStitchAgain && (
                            <button onClick={onStitchAgain} title="Stitch the current images again">
                                <img src={StitchAgain21px} alt="Stitch again" />
                            </button>
                        )}
                        {stitching && (
                            <button onClick={() => void onCancelStitch()} title="Cancel stitching">
                                <img src={Cancel21px} alt="Cancel stitching" />
                            </button>
                        )}
                        <button
                            className={confirmClear ? "confirm" : undefined}
                            onClick={() => void onClear()}
                            disabled={stitching || (images.length === 0 && !panorama)}
                            title={confirmClear ? "Click again to clear all images" : "Clear all images"}
                        >
                            <img src={Trash21px} alt="Clear images" />
                            {confirmClear && <span>Clear all?</span>}
                        </button>
                        <button onClick={() => navigate("/settings")} title="Settings">
                            <img src={SettingsIcon21px} alt="Settings" />
                        </button>
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

                {!displaySource && (
                    <div className="empty-state">
                        <h3>No images yet</h3>
                        <p>Open drone photos to stitch them into a panorama and measure water.</p>
                        <button onClick={() => void pick("replace")} disabled={stitching}>
                            <img src={FolderOpen21px} alt="" />
                            Open images
                        </button>
                    </div>
                )}

                {(notice || status) && (
                    <div className="top-stack">
                        {notice && (
                            <div className={`notice ${notice.kind}`} title={notice.text}>
                                <span className="text">{notice.text}</span>
                            </div>
                        )}
                        {status && (
                            <div className={`status-bar ${status.kind}`} title={status.text} role="status">
                                {status.kind === "progress" && <span className="spinner" aria-hidden="true" />}
                                <span className="text">{status.text}</span>
                                {status.kind !== "progress" && (
                                    <button className="dismiss" onClick={clearStatus} title="Dismiss" aria-label="Dismiss">
                                        ×
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <div className="controls">
                    <div
                        className={`color-picker${picking ? " active" : ""}`}
                        id="color-picker"
                        role="button"
                        aria-pressed={picking}
                        title="Pick a new reference colour"
                        onClick={() => setPicking((active) => !active)}
                    >
                        <img src={EyedropperIcon21px} alt="Colour picker" />
                    </div>
                    <div className="slider-container" title="Colour tolerance (hue)">
                        <input
                            type="range"
                            min="1"
                            max="50"
                            step="1"
                            className="slider"
                            id="hsvValue"
                            value={tolerance}
                            onChange={(e) => setTolerance(Number(e.target.value))}
                        />
                        <span className="slider-value">±{tolerance}</span>
                    </div>
                    <button className="fit-button" onClick={fit} disabled={!current} title="Fit to window (0) · zoom with +/- or the scroll wheel">
                        <img src={Fit21px} alt="Fit to window" />
                    </button>
                </div>

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
