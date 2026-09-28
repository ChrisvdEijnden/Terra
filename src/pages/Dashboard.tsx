import { useNavigate } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "../styles/global.css";
import "./dashboard.css";

import {
    calculateArea,
    computeWaterMask,
    getHueAtPixel,
    labelAt,
    toggleAreaSelection,
    buildOverlayImageData,
} from "../lib/CalculateArea";
import CopyToClipboard from "../lib/CopyToClipboard.tsx";

import LogoIcon26px from "../assets/icons/logo-26px.svg";
import SettingsIcon21px from "../assets/icons/settings-21px.svg";
import EyedropperIcon21px from "../assets/icons/eyedropper-21px.svg";
import FolderOpen21px from "../assets/icons/folderopen-21px.svg";

interface Transform {
    scale: number;
    offsetX: number;
    offsetY: number;
}

function Dashboard() {
    const navigate = useNavigate();

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const overlayCanvasElRef = useRef<HTMLCanvasElement | null>(null);
    const transformRef = useRef<Transform | null>(null);

    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [naturalImageData, setNaturalImageData] = useState<ImageData | null>(null);
    const [hsvValue, setHsvValue] = useState(1);

    const [clickedHue, setClickedHue] = useState<number | null>(null);
    const [picking, setPicking] = useState(true);
    const [deselectedLabels, setDeselectedLabels] = useState<Set<number>>(new Set());

    const [gsd, setGsd] = useState<number | null>(null);

    const handleFileChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];

            if (!file) return;
            if (!file.type.startsWith("image/")) return;

            const newImageUrl = URL.createObjectURL(file);

            setImageUrl(newImageUrl);

            event.target.value = "";
        },
        []
    );

    const openFilePicker = useCallback(() => {
        const input = fileInputRef.current;

        if (!input) return;
        input.click();
    }, []);

    useEffect(() => {
        if (!imageUrl) return;

        return () => {
            URL.revokeObjectURL(imageUrl);
        };
    }, [imageUrl]);

    useEffect(() => {
        if (!imageUrl) {
            imageRef.current = null;
            setNaturalImageData(null);
            return;
        }

        let cancelled = false;
        const image = new Image();

        image.onload = () => {
            if (cancelled) return;

            imageRef.current = image;

            const offscreen = document.createElement("canvas");
            offscreen.width = image.naturalWidth;
            offscreen.height = image.naturalHeight;
            const offscreenCtx = offscreen.getContext("2d");
            if (!offscreenCtx) return;

            offscreenCtx.drawImage(image, 0, 0);
            const data = offscreenCtx.getImageData(0, 0, image.naturalWidth, image.naturalHeight);

            setNaturalImageData(data);
            setClickedHue(null);
            setDeselectedLabels(new Set());
            setPicking(true);
        };

        image.src = imageUrl;

        return () => {
            cancelled = true;
        };
    }, [imageUrl]);

    const maskResult = useMemo(() => {
        if (!naturalImageData || clickedHue === null) return null;
        return computeWaterMask(naturalImageData, clickedHue, hsvValue, deselectedLabels);
    }, [naturalImageData, clickedHue, hsvValue, deselectedLabels]);

    const area = useMemo(() => {
        if (!maskResult || gsd === null || !(gsd > 0)) return null;
        return calculateArea(maskResult.pixelCount, gsd);
    }, [maskResult, gsd]);

    const areaLabelText = !imageUrl
        ? "Open an image to start"
        : picking
            ? "Click water to set reference color"
            : !maskResult
                ? "Click water to start"
                : area === null
                    ? "Enter GSD to compute area"
                    : `Area: ${area.toFixed(3)} ha`;

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        if (cssWidth === 0 || cssHeight === 0) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(cssWidth * dpr);
        canvas.height = Math.round(cssHeight * dpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const image = imageRef.current;
        if (!image) return;

        const scale = Math.max(cssWidth / image.naturalWidth, cssHeight / image.naturalHeight);
        const drawWidth = image.naturalWidth * scale;
        const drawHeight = image.naturalHeight * scale;
        const offsetX = (cssWidth - drawWidth) / 2;
        const offsetY = (cssHeight - drawHeight) / 2;

        transformRef.current = { scale, offsetX, offsetY };

        ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);

        const overlayCanvasEl = overlayCanvasElRef.current;
        if (overlayCanvasEl && overlayCanvasEl.width > 0 && overlayCanvasEl.height > 0) {
            ctx.drawImage(overlayCanvasEl, offsetX, offsetY, drawWidth, drawHeight);
        }
    }, []);

    useEffect(() => {
        if (!overlayCanvasElRef.current) {
            overlayCanvasElRef.current = document.createElement("canvas");
        }
        const overlayCanvasEl = overlayCanvasElRef.current;

        if (maskResult) {
            overlayCanvasEl.width = maskResult.width;
            overlayCanvasEl.height = maskResult.height;
            const overlayCtx = overlayCanvasEl.getContext("2d");
            if (overlayCtx) {
                overlayCtx.putImageData(buildOverlayImageData(maskResult, deselectedLabels), 0, 0);
            }
        } else {
            overlayCanvasEl.width = 0;
            overlayCanvasEl.height = 0;
        }

        draw();
    }, [maskResult, deselectedLabels, draw]);

    useEffect(() => {
        draw();
    }, [naturalImageData, draw]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const resizeObserver = new ResizeObserver(() => draw());
        resizeObserver.observe(container);
        return () => resizeObserver.disconnect();
    }, [draw]);

    const handleCanvasClick = useCallback(
        (event: React.MouseEvent<HTMLCanvasElement>) => {
            const canvas = canvasRef.current;
            const transform = transformRef.current;
            if (!canvas || !transform || !naturalImageData) return;

            const rect = canvas.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            const clickY = event.clientY - rect.top;

            const imgX = Math.floor((clickX - transform.offsetX) / transform.scale);
            const imgY = Math.floor((clickY - transform.offsetY) / transform.scale);

            if (imgX < 0 || imgY < 0 || imgX >= naturalImageData.width || imgY >= naturalImageData.height) {
                return;
            }

            if (picking) {
                setClickedHue(getHueAtPixel(naturalImageData, imgX, imgY));
                setDeselectedLabels(new Set());
                setPicking(false);
            } else if (maskResult) {
                const label = labelAt(maskResult, imgX, imgY);
                if (label !== null) {
                    setDeselectedLabels((prev) => toggleAreaSelection(prev, label));
                }
            }
        },
        [picking, maskResult, naturalImageData]
    );

    const handleToleranceChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setHsvValue(Number(event.target.value));
        setDeselectedLabels(new Set());
    }, []);

    const toggleColorPicking = useCallback(() => {
        setPicking((active) => !active);
    }, []);

    const canvasCursor = picking ? "crosshair" : maskResult ? "pointer" : "default";

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
                    <div className="gsd">
                        <p>
                            GSD:{" "}
                            <input
                                type="number"
                                step="any"
                                min="0"
                                placeholder="0.0883"
                                value={gsd ?? ""}
                                onChange={(e) =>
                                    setGsd(e.target.value === "" ? null : parseFloat(e.target.value))
                                }
                            />
                            m
                        </p>
                    </div>
                    <div
                        className="area"
                        onClick={() => {
                            if (area !== null) CopyToClipboard(area);
                        }}
                    >
                        <p>{areaLabelText}</p>
                    </div>

                    <div className="right-system-actions">
                        <button onClick={openFilePicker}>
                            <img src={FolderOpen21px} alt="Open image" />

                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                onChange={handleFileChange}
                                hidden
                            />
                        </button>
                        <button onClick={() => navigate("/settings")}>
                            <img src={SettingsIcon21px} alt="Settings" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="content-dashboard" ref={containerRef}>
                <canvas
                    className="background"
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    style={{ cursor: canvasCursor }}
                />

                <div className="controls">
                    <div
                        className={`color-picker${picking ? " active" : ""}`}
                        id="color-picker"
                        role="button"
                        aria-pressed={picking}
                        title="Pick a new reference color"
                        onClick={toggleColorPicking}
                    >
                        <img src={EyedropperIcon21px} alt="Color picker" />
                    </div>
                    <div className="slider-container">
                        <input
                            type="range"
                            min="1"
                            max="50"
                            step="1"
                            className="slider"
                            id="hsvValue"
                            value={hsvValue}
                            onChange={handleToleranceChange}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Dashboard;