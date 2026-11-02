// React hook that owns the mask Web Worker: sends the image pixels once, then
// requests segmentations with latest-wins semantics (at most one job in flight;
// results for outdated parameters or images are dropped).
import { useCallback, useEffect, useRef, useState } from "react";
import type { MaskRequest, MaskResponse } from "./maskProtocol.ts";
import { useTranslation } from "./useTranslations.ts";

export interface HueInfo {
    imageId: number;
    width: number;
    height: number;
    /** 0..179, INELIGIBLE (255) where the pixel can never be selected. */
    hue: Uint8Array;
    eligibleCount: number;
}

export interface Segmentation {
    imageId: number;
    /** Worker job that produced it (unique for the lifetime of the hook). */
    jobId: number;
    width: number;
    height: number;
    refHue: number;
    tolerance: number;
    /** Label per pixel; boundary pixels are negated (see waterMask.markBoundaries). */
    labels: Int32Array;
    areas: Int32Array;
    ms: number;
}

export interface SegmentParams {
    refHue: number;
    tolerance: number;
}

export function useWaterMask() {
    const { t } = useTranslation();
    const tRef = useRef(t);
    tRef.current = t;
    const workerRef = useRef<Worker | null>(null);
    const imageCounter = useRef(0);
    const jobCounter = useRef(0);
    /** Image the UI currently wants analyzed (0 = none). */
    const imageIdRef = useRef(0);
    const hueInfoRef = useRef<HueInfo | null>(null);
    const desiredRef = useRef<SegmentParams | null>(null);
    const appliedRef = useRef<SegmentParams | null>(null);
    const inFlightRef = useRef<number | null>(null);
    const inFlightParamsRef = useRef<SegmentParams | null>(null);
    /** Parameters whose job failed; not resent until the parameters change. */
    const failedRef = useRef<SegmentParams | null>(null);

    const [hueInfo, setHueInfo] = useState<HueInfo | null>(null);
    const [segmentation, setSegmentation] = useState<Segmentation | null>(null);
    const [analysing, setAnalysing] = useState(false);
    const [segmenting, setSegmenting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Image id the worker was analyzing when it crashed (0 = no crash). */
    const [crashedImageId, setCrashedImageId] = useState(0);

    const handleMessageRef = useRef<(msg: MaskResponse) => void>(() => {});

    const getWorker = useCallback((): Worker => {
        if (workerRef.current) return workerRef.current;
        const worker = new Worker(new URL("./maskWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<MaskResponse>) => handleMessageRef.current(event.data);
        worker.onerror = (event) => {
            event.preventDefault();
            // The worker died (e.g. out of memory); start fresh next time.
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            inFlightRef.current = null;
            hueInfoRef.current = null;
            appliedRef.current = null;
            setCrashedImageId(imageIdRef.current);
            imageIdRef.current = 0; // the image is gone with the worker; it has to be sent again
            setHueInfo(null);
            setSegmentation(null);
            setAnalysing(false);
            setSegmenting(false);
            setError(
                event.message
                    ? tRef.current("dashboard.analysisStoppedDetail", { error: event.message })
                    : tRef.current("dashboard.analysisStopped")
            );
        };
        workerRef.current = worker;
        return worker;
    }, []);

    const post = useCallback(
        (msg: MaskRequest, transfer: Transferable[] = []) => getWorker().postMessage(msg, transfer),
        [getWorker]
    );

    const pump = useCallback(() => {
        if (inFlightRef.current !== null) return;
        const desired = desiredRef.current;
        const info = hueInfoRef.current;
        if (!desired || !info || info.imageId !== imageIdRef.current) {
            setSegmenting(false);
            return;
        }
        const applied = appliedRef.current;
        const failed = failedRef.current;
        if (
            (applied && applied.refHue === desired.refHue && applied.tolerance === desired.tolerance) ||
            (failed && failed.refHue === desired.refHue && failed.tolerance === desired.tolerance)
        ) {
            setSegmenting(false);
            return;
        }
        const jobId = ++jobCounter.current;
        inFlightRef.current = jobId;
        inFlightParamsRef.current = { refHue: desired.refHue, tolerance: desired.tolerance };
        setSegmenting(true);
        post({ type: "segment", imageId: info.imageId, jobId, refHue: desired.refHue, tolerance: desired.tolerance });
    }, [post]);

    handleMessageRef.current = (msg: MaskResponse) => {
        switch (msg.type) {
            case "imageReady": {
                if (msg.imageId !== imageIdRef.current) return; // stale image
                const info: HueInfo = {
                    imageId: msg.imageId,
                    width: msg.width,
                    height: msg.height,
                    hue: new Uint8Array(msg.hue),
                    eligibleCount: msg.eligibleCount,
                };
                hueInfoRef.current = info;
                setHueInfo(info);
                setAnalysing(false);
                pump();
                return;
            }
            case "segmented": {
                if (msg.jobId !== inFlightRef.current) return; // superseded
                inFlightRef.current = null;
                const desired = desiredRef.current;
                const info = hueInfoRef.current;
                if (
                    info &&
                    desired &&
                    msg.imageId === imageIdRef.current &&
                    msg.imageId === info.imageId &&
                    desired.refHue === msg.refHue &&
                    desired.tolerance === msg.tolerance
                ) {
                    appliedRef.current = { refHue: msg.refHue, tolerance: msg.tolerance };
                    setSegmentation({
                        imageId: msg.imageId,
                        jobId: msg.jobId,
                        width: info.width,
                        height: info.height,
                        refHue: msg.refHue,
                        tolerance: msg.tolerance,
                        labels: new Int32Array(msg.labels),
                        areas: new Int32Array(msg.areas),
                        ms: msg.ms,
                    });
                }
                pump();
                return;
            }
            case "error": {
                if (msg.jobId !== null && msg.jobId === inFlightRef.current) {
                    inFlightRef.current = null;
                    // Remember the failure so pump() does not resend the same job forever;
                    // new parameters (slider, new pick) retry. The old result does not
                    // belong to the requested parameters, so it is not shown either.
                    failedRef.current = inFlightParamsRef.current;
                    appliedRef.current = null;
                    setSegmentation(null);
                }
                if (msg.imageId === null || msg.imageId === imageIdRef.current) {
                    setError(msg.message);
                    setAnalysing(false);
                }
                pump();
                return;
            }
        }
    };

    useEffect(() => {
        return () => {
            workerRef.current?.terminate();
            workerRef.current = null;
            inFlightRef.current = null;
        };
    }, []);

    const resetState = useCallback(() => {
        hueInfoRef.current = null;
        desiredRef.current = null;
        appliedRef.current = null;
        inFlightRef.current = null;
        failedRef.current = null;
        setHueInfo(null);
        setSegmentation(null);
        setSegmenting(false);
        setError(null);
        setCrashedImageId(0);
    }, []);

    /** Hands the pixels to the worker (the ImageData buffer is transferred). Returns the image id. */
    const setImage = useCallback(
        (pixels: ImageData): number => {
            resetState();
            const imageId = ++imageCounter.current;
            imageIdRef.current = imageId;
            setAnalysing(true);
            const rgba = pixels.data.buffer as ArrayBuffer;
            post({ type: "setImage", imageId, width: pixels.width, height: pixels.height, rgba }, [rgba]);
            return imageId;
        },
        [post, resetState]
    );

    /** Forget the current image (frees the worker's buffers). */
    const clearImage = useCallback(() => {
        resetState();
        imageIdRef.current = 0;
        setAnalysing(false);
        workerRef.current?.postMessage({ type: "clear" } satisfies MaskRequest);
    }, [resetState]);

    /** Latest wins: only the most recent parameters are ever applied. */
    const requestSegmentation = useCallback(
        (params: SegmentParams | null) => {
            desiredRef.current = params;
            if (!params) {
                appliedRef.current = null;
                setSegmentation(null);
            }
            pump();
        },
        [pump]
    );

    const clearError = useCallback(() => setError(null), []);

    return {
        hueInfo,
        segmentation,
        analysing,
        segmenting,
        error,
        crashedImageId,
        clearError,
        setImage,
        clearImage,
        requestSegmentation,
    };
}
