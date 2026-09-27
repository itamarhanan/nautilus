export async function openInNewTab(resolveUrl: () => Promise<string>): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("The browser blocked the new tab. Allow pop-ups and try again.");
  tab.opener = null;
  try {
    tab.location.href = await resolveUrl();
  } catch (error) {
    tab.close();
    throw error;
  }
}

export function insertLineBreak(editable: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const lineBreak = document.createElement("br");
  range.insertNode(lineBreak);

  if (!lineBreak.nextSibling) lineBreak.after(document.createElement("br"));
  range.setStartAfter(lineBreak);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
}

export function guessDeviceName(): string {
  const agent = window.navigator.userAgent;
  if (/iPad/.test(agent)) return "iPad";
  if (/iPhone/.test(agent)) return "iPhone";
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? "Android phone" : "Android tablet";
  return "Browser";
}
