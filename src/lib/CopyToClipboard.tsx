export default function CopyToClipboard(area: number) {
    navigator.clipboard.writeText(area.toString());
}