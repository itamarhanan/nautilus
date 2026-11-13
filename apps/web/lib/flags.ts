export function previewEnabled(): boolean {
  return process.env.NAUTILUS_PREVIEW_ENABLED === "1" || process.env.NAUTILUS_PREVIEW_ENABLED === "true";
}
