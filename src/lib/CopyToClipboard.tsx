/** Copies the area (hectares) to the clipboard. Resolves when done, rejects if the clipboard is unavailable. */
export default function CopyToClipboard(area: number): Promise<void> {
    if (!navigator.clipboard) return Promise.reject(new Error("clipboard not available"));
    return navigator.clipboard.writeText(area.toString());
}
