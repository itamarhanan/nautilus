import type { Usage } from "./usage";

export type ToolStatus = "pending" | "running" | "complete" | "error";

export type ToolCall = {
  id: string;
  name: string;
  status: ToolStatus;
  target?: string;
  duration?: string;
  output?: string;
  error?: string;

  command?: string;

  subagent?: {
    sessionId: string | null;
    agentType: string | null;
    prompt: string | null;
  };
};

export type AssistantPart =
  | { kind: "text"; id: string; text: string; isStreaming: boolean }
  | { kind: "reasoning"; id: string; text: string; isStreaming: boolean }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "patch"; id: string; files: string[] };

export type PermissionResponse = "once" | "always" | "reject";

export type TranscriptItem =
  | {
      kind: "user";
      key: string;
      text: string;
      timestamp: string;

      isPending: boolean;
    }
  | {
      kind: "assistant";
      key: string;
      parts: AssistantPart[];
      timestamp: string;
      model: string | null;
      error: string | null;

      usage: Usage | null;

      turnUsage: Usage | null;
    }
  | {
      kind: "notice";
      key: string;
      tone: "info" | "warning" | "error";
      text: string;
      timestamp: string;
    }
  | {
      kind: "checkpoint";
      key: string;
      commit: string;

      previousHead: string | null;

      revertOf: string | null;
      timestamp: string;
    }
  | {
      kind: "permission";
      key: string;
      id: string;

      permission: string;

      patterns: string[];
      timestamp: string;
      response: PermissionResponse | null;
    };

export type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
