import { record, text } from "../values";
import type { ToolCall, ToolStatus } from "./items";

const TOOL_STATUS: Record<string, ToolStatus> = {
  pending: "pending",
  running: "running",
  completed: "complete",
  error: "error",
};

const MAX_TARGET = 80;

function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fullToolTarget(state: Record<string, unknown>): string | undefined {
  const input = record(state.input);
  return (
    text(state.title) ??
    text(input.filePath) ??
    text(input.path) ??
    text(input.command) ??
    text(input.pattern) ??
    text(input.url) ??
    text(input.description) ??
    undefined
  );
}

function toolTarget(state: Record<string, unknown>): string | undefined {
  const target = fullToolTarget(state);
  const line = target?.split("\n", 1)[0]?.trim();
  if (!line) return undefined;
  return line.length > MAX_TARGET || line !== target?.trim()
    ? `${line.slice(0, MAX_TARGET).trimEnd()}…`
    : line;
}

export function toToolCall(part: Record<string, unknown>): ToolCall {
  const state = record(part.state);
  const time = record(state.time);
  const start = typeof time.start === "number" ? time.start : null;
  const end = typeof time.end === "number" ? time.end : null;
  const input = record(state.input);
  const name = text(part.tool) ?? "tool";
  return {
    id: text(part.id) ?? text(part.callID) ?? "tool",
    name,
    status: TOOL_STATUS[text(state.status) ?? ""] ?? "pending",
    target: toolTarget(state),
    duration: start !== null && end !== null ? formatDuration(end - start) : undefined,
    output: text(state.output) ?? undefined,
    error: text(state.error) ?? undefined,
    command: name === "bash" ? (text(input.command) ?? undefined) : undefined,
    subagent:
      name === "task"
        ? {
            sessionId: text(record(state.metadata).sessionId),
            agentType: text(input.subagent_type),
            prompt: text(input.prompt),
          }
        : undefined,
  };
}
