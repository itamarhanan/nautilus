import { subagent as subagentText } from "@nautilus/copy";
import type { SessionEvent } from "@nautilus/types";
import { isTerminalEvent, record, text } from "../values";
import type { ToolStatus, TranscriptItem } from "./items";
import { toToolCall } from "./tools";

export type Subagent = {
  id: string;
  title: string;
  agentType: string | null;

  prompt: string | null;
  status: ToolStatus;
  error: string | null;
};

export type SubagentSummary = Subagent & {
  activity: string | null;
  steps: number;
};

export type Thread = SubagentSummary & { items: TranscriptItem[] };

export function subagentOf(event: SessionEvent): string | null {
  return text(event.payload.subagent);
}

export function threadEvents(
  events: readonly SessionEvent[],
  subagent: string | null,
): SessionEvent[] {
  return events.filter(
    (event) =>
      subagentOf(event) === subagent || (subagent === null && event.type === "session.permission"),
  );
}

export function subagentsOf(events: readonly SessionEvent[]): Subagent[] {
  const byId = new Map<string, Subagent>();
  let isOver = false;
  for (const event of events) {
    const tagged = subagentOf(event);
    if (tagged) {
      if (!byId.has(tagged)) {
        byId.set(tagged, {
          id: tagged,
          title: subagentText.title,
          agentType: null,
          prompt: null,
          status: "running",
          error: null,
        });
      }
      continue;
    }
    if (event.type === "session.tool") {
      const call = toToolCall(record(event.payload.part));
      const id = call.subagent?.sessionId;
      if (!call.subagent || !id) continue;
      byId.set(id, {
        id,
        title: call.target ?? subagentText.title,
        agentType: call.subagent.agentType,
        prompt: call.subagent.prompt,
        status: call.status,
        error: call.error ?? null,
      });
    }
    isOver = isTerminalEvent(event);
    if (event.type === "session.retry" || event.type === "session.message") isOver = false;
  }
  const subagents = [...byId.values()];

  return isOver
    ? subagents.map((subagent) =>
        subagent.status === "running" || subagent.status === "pending"
          ? { ...subagent, status: "error" as const }
          : subagent,
      )
    : subagents;
}
