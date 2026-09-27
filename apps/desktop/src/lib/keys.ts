const EDITABLE = "input, textarea, select, [contenteditable]";

export function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function isModEnter(event: KeyboardEvent): boolean {
  return isMod(event) && event.key === "Enter";
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(EDITABLE) !== null;
}
