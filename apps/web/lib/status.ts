import { activity, subagent, type Tone } from "@nautilus/copy";
import type { ToolStatus } from "./transcript";

export type StatusView = {
  label: string;
  tone: Tone;
  isBusy: boolean;
};

const STATUS_VIEWS: Record<ToolStatus, StatusView> = {
  pending: { label: subagent.starting, tone: "accent", isBusy: true },
  running: { label: activity.working, tone: "accent", isBusy: true },
  complete: { label: subagent.done, tone: "success", isBusy: false },
  error: { label: subagent.failed, tone: "error", isBusy: false },
};

export function toolStatusView(status: ToolStatus): StatusView {
  return STATUS_VIEWS[status];
}
