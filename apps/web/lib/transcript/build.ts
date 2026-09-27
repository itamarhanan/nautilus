import { transcript as notice } from "@nautilus/copy";
import type { SessionEvent, SessionEventType } from "@nautilus/types";
import { errorText, record, text } from "../values";
import type { AssistantItem, AssistantPart, PermissionResponse, TranscriptItem } from "./items";
import { toToolCall } from "./tools";
import { addUsage, type Usage, usageOf } from "./usage";

export type TranscriptLive = {
  streaming?: Readonly<Record<string, string>>;

  outgoing?: { text: string; timestamp: string } | null;
};

type FoldState = {
  items: TranscriptItem[];
  assistants: Map<string, AssistantItem>;
  userMessageIds: Set<string>;
};

type Reducer = (state: FoldState, event: SessionEvent) => void;

type PermissionItem = Extract<TranscriptItem, { kind: "permission" }>;

type PartKind = "text" | "reasoning";

function permissionResponse(value: unknown): PermissionResponse | null {
  return value === "once" || value === "always" || value === "reject" ? value : null;
}

function eventKey(event: SessionEvent, prefix: string): string {
  return `${prefix}:${String(event.sequence)}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function partKind(part: Record<string, unknown>): PartKind | null {
  return part.type === "reasoning" ? "reasoning" : part.type === "text" ? "text" : null;
}

function findPermission(items: readonly TranscriptItem[], id: string): PermissionItem | undefined {
  return items.find((item): item is PermissionItem => item.kind === "permission" && item.id === id);
}

function isRepeatNotice(items: readonly TranscriptItem[], message: string): boolean {
  const previous = items.at(-1);
  if (previous?.kind === "notice" && previous.text === message) return true;
  const before = items.at(-2);
  return previous?.kind === "notice" && before?.kind === "notice" && before.text === message;
}

function pushNotice(
  state: FoldState,
  event: SessionEvent,
  tone: "info" | "warning" | "error",
  message: string,
): void {
  if (isRepeatNotice(state.items, message)) return;
  state.items.push({
    kind: "notice",
    key: eventKey(event, "notice"),
    tone,
    text: message,
    timestamp: event.timestamp,
  });
}

function assistantFor(state: FoldState, messageId: string, timestamp: string): AssistantItem {
  const existing = state.assistants.get(messageId);
  if (existing) return existing;
  const item: AssistantItem = {
    kind: "assistant",
    key: `assistant:${messageId}`,
    parts: [],
    timestamp,
    model: null,
    error: null,
    usage: null,
    turnUsage: null,
  };
  state.assistants.set(messageId, item);
  state.items.push(item);
  return item;
}

function upsertPart(item: AssistantItem, part: AssistantPart): void {
  const index = item.parts.findIndex((candidate) => candidate.id === part.id);
  if (index === -1) item.parts.push(part);
  else item.parts[index] = part;
}

function applyUserMessage(
  state: FoldState,
  event: SessionEvent,
  info: Record<string, unknown>,
): void {
  const id = text(info.id);
  if (id) state.userMessageIds.add(id);
  const prompt = text(info.text);
  if (!prompt) return;
  state.items.push({
    kind: "user",
    key: eventKey(event, "user"),
    text: prompt,
    timestamp: event.timestamp,
    isPending: false,
  });
}

function applyAssistantMeta(
  state: FoldState,
  event: SessionEvent,
  info: Record<string, unknown>,
): void {
  const item = assistantFor(state, text(info.id) ?? "", event.timestamp);
  item.model = text(info.modelID) ?? item.model;
  item.usage = usageOf(info) ?? item.usage;
  if (record(info.error).name === "MessageAbortedError") return;
  item.error = errorText(info.error) ?? item.error;
}

function applyMessagePart(
  state: FoldState,
  event: SessionEvent,
  part: Record<string, unknown>,
): void {
  const messageId = text(part.messageID);
  if (!messageId || state.userMessageIds.has(messageId)) return;
  const kind = partKind(part);
  if (!kind || part.ignored === true || part.synthetic === true) return;
  const id = text(part.id) ?? eventKey(event, "event");
  const item = assistantFor(state, messageId, event.timestamp);
  const stored = text(part.text) ?? "";
  if (stored || !item.parts.some((candidate) => candidate.id === id)) {
    upsertPart(item, { kind, id, text: stored, isStreaming: false });
  }
}

function applyMessageEvent(state: FoldState, event: SessionEvent): void {
  const message = event.payload.message;
  if (typeof message === "string") {
    const id = eventKey(event, "event");
    upsertPart(assistantFor(state, id, event.timestamp), {
      kind: "text",
      id,
      text: message,
      isStreaming: false,
    });
    return;
  }
  const info = record(message);
  const part = record(event.payload.part);
  if (info.role === "user") {
    applyUserMessage(state, event, info);
  } else if (info.role === "assistant" && text(info.id)) {
    applyAssistantMeta(state, event, info);
  } else {
    applyMessagePart(state, event, part);
  }
}

function applyToolEvent(state: FoldState, event: SessionEvent): void {
  const part = record(event.payload.part);
  const call = toToolCall(part);
  upsertPart(
    assistantFor(state, text(part.messageID) ?? eventKey(event, "event"), event.timestamp),
    {
      kind: "tool",
      id: call.id,
      call,
    },
  );
}

function applyFileChangeEvent(state: FoldState, event: SessionEvent): void {
  const part = record(event.payload.part);
  const files = stringList(part.files);
  if (files.length === 0) return;
  const messageId = text(part.messageID) ?? eventKey(event, "event");
  upsertPart(assistantFor(state, messageId, event.timestamp), {
    kind: "patch",
    id: text(part.id) ?? eventKey(event, "event"),
    files,
  });
}

function applyPermissionEvent(state: FoldState, event: SessionEvent): void {
  const id = text(event.payload.id);
  if (!id) return;
  const response = permissionResponse(event.payload.response);
  const asked = findPermission(state.items, id);
  if (asked) {
    if (response) asked.response = response;
    return;
  }
  if (response) return;
  state.items.push({
    kind: "permission",
    key: `permission:${id}`,
    id,
    permission: text(event.payload.permission) ?? notice.defaultPermission,
    patterns: stringList(event.payload.patterns),
    timestamp: event.timestamp,
    response: null,
  });
}

function applyCheckpointEvent(state: FoldState, event: SessionEvent): void {
  const commit = text(event.payload.commit);
  if (!commit || !("previousHead" in event.payload)) {
    pushNotice(
      state,
      event,
      "info",
      commit ? notice.checkpoint(commit) : notice.changesCheckpointed,
    );
    return;
  }
  state.items.push({
    kind: "checkpoint",
    key: eventKey(event, "checkpoint"),
    commit,
    previousHead: text(event.payload.previousHead),
    revertOf: text(event.payload.revertOf),
    timestamp: event.timestamp,
  });
}

const noop: Reducer = () => {};

const noticeReducer =
  (tone: "info" | "warning" | "error", copy: (event: SessionEvent) => string): Reducer =>
  (state, event) => {
    pushNotice(state, event, tone, copy(event));
  };

const REDUCERS: Record<SessionEventType, Reducer> = {
  "session.message": applyMessageEvent,
  "session.tool": applyToolEvent,
  "session.file_change": applyFileChangeEvent,
  "session.permission": applyPermissionEvent,
  "session.checkpoint": applyCheckpointEvent,
  "session.retry": noticeReducer("info", () => notice.retrying),
  "session.interrupted": noticeReducer("warning", () => notice.turnInterrupted),
  "session.error": noticeReducer(
    "error",
    (event) => errorText(event.payload.error) ?? notice.turnFailed,
  ),
  "session.started": noop,
  "session.delta": noop,
  "session.todo": noop,
  "session.completed": noop,
};

function assignTurnUsage(items: TranscriptItem[]): void {
  let turn: AssistantItem[] = [];
  const closeTurn = () => {
    const total = turn.reduce<Usage | null>((sum, item) => addUsage(sum, item.usage), null);
    for (const item of turn) item.turnUsage = total;
    turn = [];
  };
  for (const item of items) {
    if (item.kind === "user") closeTurn();
    else if (item.kind === "assistant") turn.push(item);
  }
  closeTurn();
}

export function foldEvents(events: readonly SessionEvent[]): readonly TranscriptItem[] {
  const state: FoldState = { items: [], assistants: new Map(), userMessageIds: new Set() };
  for (const event of events) REDUCERS[event.type](state, event);
  assignTurnUsage(state.items);
  return state.items;
}

const isTextPart = (
  part: AssistantPart,
): part is Extract<AssistantPart, { kind: "text" | "reasoning" }> =>
  part.kind === "text" || part.kind === "reasoning";

export function withLive(
  folded: readonly TranscriptItem[],
  live: TranscriptLive = {},
): TranscriptItem[] {
  const streaming = live.streaming ?? {};
  const visible: TranscriptItem[] = [];
  for (const item of folded) {
    if (item.kind !== "assistant") {
      visible.push(item);
      continue;
    }
    const touched = item.parts.some(
      (part) => isTextPart(part) && (part.text === "" || part.id in streaming),
    );
    const shown = touched
      ? {
          ...item,
          parts: item.parts.flatMap((part): AssistantPart[] => {
            if (!isTextPart(part)) return [part];
            const isStreaming = part.id in streaming;
            const partText = part.text + (isStreaming ? (streaming[part.id] ?? "") : "");
            return partText ? [{ ...part, text: partText, isStreaming }] : [];
          }),
        }
      : item;
    if (shown.parts.length > 0 || shown.error !== null) visible.push(shown);
  }
  if (live.outgoing) {
    visible.push({
      kind: "user",
      key: "user:outgoing",
      text: live.outgoing.text,
      timestamp: live.outgoing.timestamp,
      isPending: true,
    });
  }
  return visible;
}

export function buildTranscript(
  events: readonly SessionEvent[],
  live: TranscriptLive = {},
): TranscriptItem[] {
  return withLive(foldEvents(events), live);
}
