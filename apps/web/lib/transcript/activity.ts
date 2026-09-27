import { activity as text } from "@nautilus/copy";
import type { TranscriptItem } from "./items";

export function currentActivity(items: readonly TranscriptItem[]): string | null {
  if (items.some((item) => item.kind === "permission" && item.response === null)) {
    return text.waitingForApproval;
  }
  const last = items.at(-1);
  if (!last || last.kind !== "assistant") {
    return last?.kind === "user" && last.isPending ? text.sending : text.thinking;
  }
  const part = last.parts.at(-1);
  if (!part) return text.thinking;
  switch (part.kind) {
    case "text":
      return part.isStreaming ? null : text.thinking;
    case "reasoning":
      return text.thinking;
    case "tool":
      if (part.call.status === "pending" || part.call.status === "running") {
        if (part.call.subagent) return text.waitingOn(part.call.target ?? text.anonymousSubagent);
        return text.runningTool(part.call.name, part.call.target);
      }
      return text.thinking;
    case "patch":
      return text.editingFiles;
  }
}
