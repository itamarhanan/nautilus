import { subagent as text } from "@nautilus/copy";
import { isRunning } from "./session-view";
import type { SubagentSummary, ToolCall, ToolStatus } from "./transcript";

export type SubagentCardView = {
  id: string | null;
  status: ToolStatus;
  title: string;
  agentType: string | null;
  detail: string;
  isOpenable: boolean;
};

function detailOf(
  status: ToolStatus,
  call: ToolCall,
  summary: SubagentSummary | undefined,
): string {
  if (isRunning(status)) return summary?.activity ?? text.starting;
  if (status === "error") return call.error ?? summary?.error ?? text.stoppedEarly;
  return [summary ? text.toolCalls(summary.steps) : null, call.duration]
    .filter(Boolean)
    .join(" · ");
}

export function subagentCardView(
  call: ToolCall,
  summary: SubagentSummary | undefined,
): SubagentCardView {
  const id = call.subagent?.sessionId ?? null;
  const status = summary?.status ?? call.status;
  return {
    id,
    status,
    title: call.target ?? summary?.title ?? text.title,
    agentType: call.subagent?.agentType ?? summary?.agentType ?? null,
    detail: detailOf(status, call, summary),
    isOpenable: id !== null,
  };
}
