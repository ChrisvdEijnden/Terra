// Small UI helpers shared by the Dashboard and the Settings menu.
import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";

/** Draws a one-colour SVG icon in the text colour (so it follows the theme and the
 *  colour of a warning or error), with the icon as a CSS mask. Use on `.icon-mask`. */
export function maskIcon(url: string): CSSProperties {
    const image = `url("${url}")`;
    return { WebkitMaskImage: image, maskImage: image };
}

export function prefersReducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Popover exit, in ms (matches .popover-exit in dashboard.css). */
const EXIT_MS = 120;

/**
 * Keeps a pop-up mounted for its exit animation after `open` turns false.
 * `closing` is true during that animation.
 */
export function usePresence(open: boolean): { mounted: boolean; closing: boolean } {
    const [leaving, setLeaving] = useState(false);
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        // adjust during render: the frame `open` turns false must still show the pop-up
        setWasOpen(open);
        setLeaving(!open && !prefersReducedMotion());
    }
    useEffect(() => {
        if (!leaving) return;
        const timer = window.setTimeout(() => setLeaving(false), EXIT_MS);
        return () => window.clearTimeout(timer);
    }, [leaving]);
    return { mounted: open || leaving, closing: !open && leaving };
}

/**
 * Arrow keys for a radio group of buttons: left/up picks the previous option, right/down
 * the next, and focus follows. `values` are in visual order; disabled ones are skipped.
 */
export function onRadioKeys<T>(
    e: KeyboardEvent<HTMLElement>,
    values: readonly T[],
    current: T,
    enabled: (value: T) => boolean,
    pick: (value: T) => void
) {
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const index = values.indexOf(current);
    for (let i = index + step; i >= 0 && i < values.length; i += step) {
        if (!enabled(values[i])) continue;
        pick(values[i]);
        const buttons = e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]");
        buttons[i]?.focus();
        return;
    }
}
