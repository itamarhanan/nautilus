export function previewEnabled(): boolean {
  const v =
    process.env.NEXT_PUBLIC_NAUTILUS_PREVIEW_ENABLED ?? process.env.NAUTILUS_PREVIEW_ENABLED;
  return v === "1" || v === "true";
}
