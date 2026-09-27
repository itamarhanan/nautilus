import type { SyncFileChange } from "@nautilus/types";

const largeDiffLines = 400;
const largeDiffCharacters = 40_000;

export type DiffDisplay =
  | { kind: "shown" }
  | { kind: "large"; changed: number }
  | { kind: "omitted"; reason: NonNullable<SyncFileChange["omitted"]> }
  | { kind: "binary" }
  | { kind: "empty" };

export function diffDisplay(file: SyncFileChange): DiffDisplay {
  if (file.binary) return { kind: "binary" };
  if (file.omitted) return { kind: "omitted", reason: file.omitted };
  const changed = file.additions + file.deletions;
  let received = 0;
  let rendered = 0;
  let characters = 0;
  for (const hunk of file.hunks) {
    rendered += hunk.lines.length;
    for (const line of hunk.lines) {
      if (line.type !== "context") received += 1;
      characters += line.content.length;
    }
  }
  if (received < changed) return { kind: "omitted", reason: "limit" };
  if (rendered === 0) return { kind: "empty" };
  if (rendered > largeDiffLines || characters > largeDiffCharacters)
    return { kind: "large", changed };
  return { kind: "shown" };
}
