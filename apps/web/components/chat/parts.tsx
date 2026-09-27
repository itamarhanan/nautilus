import { Button } from "@astryxdesign/core/Button";
import type { ChatToolCallItem } from "@astryxdesign/core/Chat";
import { ChatMessageBubble, ChatToolCalls } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { Brain } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { AssistantPart, ToolCall } from "@/lib/transcript";
import { SubagentCard } from "./subagents";

const MAX_OUTPUT = 4000;

function Reasoning({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <button
      type="button"
      className="flex w-full min-w-0 cursor-pointer flex-col gap-1 border-s-2 border-border ps-3 text-start"
      aria-expanded={isExpanded}
      onClick={() => {
        setIsExpanded((current) => !current);
      }}
    >
      <span className="inline-flex items-center gap-1.5 text-secondary">
        <Brain className="size-3.5" aria-hidden />
        <Text type="supporting" weight="medium">
          {isStreaming ? "Thinking…" : "Thought"}
        </Text>
      </span>
      {isExpanded ? (
        <Text type="supporting" className="whitespace-pre-wrap">
          {text}
        </Text>
      ) : isStreaming ? (
        <span className="flex max-h-[4.5lh] flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_1.5lh)]">
          <Text type="supporting" className="whitespace-pre-wrap">
            {text}
          </Text>
        </span>
      ) : (
        <Text type="supporting" maxLines={2} hasTruncateTooltip={false}>
          {text}
        </Text>
      )}
    </button>
  );
}

function ToolResult({ call }: { call: ToolCall }) {
  const [isFull, setFull] = useState(false);
  const output = call.output ?? "";
  const isCut = !isFull && output.length > MAX_OUTPUT;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {call.command ? (
        <CodeBlock code={call.command} language="bash" size="sm" width="100%" isWrapped />
      ) : null}
      {output ? (
        <CodeBlock
          code={isCut ? `${output.slice(0, MAX_OUTPUT)}\n…` : output}
          language="plaintext"
          size="sm"
          width="100%"
          maxHeight={isFull ? 600 : 280}
          isWrapped
        />
      ) : null}
      {isCut ? (
        <Button
          label={`Show all (${(output.length - MAX_OUTPUT).toLocaleString()} more characters)`}
          size="sm"
          variant="ghost"
          onClick={() => {
            setFull(true);
          }}
        />
      ) : null}
    </div>
  );
}

function toolItem(call: ToolCall): ChatToolCallItem {
  return {
    key: call.id,
    name: call.name,
    status: call.status,
    target: call.target,
    duration: call.duration,
    errorMessage: call.error,
    resultDetail: call.output || call.command ? <ToolResult call={call} /> : undefined,
  };
}

export function renderParts(parts: AssistantPart[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let calls: ChatToolCallItem[] = [];
  const flush = () => {
    if (calls.length === 0) return;
    nodes.push(
      <ChatToolCalls
        key={`tools:${String(calls[0]?.key)}`}
        calls={calls}
        className="w-full min-w-0 max-w-full overflow-hidden"
      />,
    );
    calls = [];
  };
  for (const part of parts) {
    if (part.kind === "tool" && part.call.subagent) {
      flush();
      nodes.push(
        <ChatMessageBubble key={part.id} variant="ghost" width="100%">
          <SubagentCard call={part.call} />
        </ChatMessageBubble>,
      );
      continue;
    }
    if (part.kind === "tool") {
      calls.push(toolItem(part.call));
      continue;
    }
    if (part.kind === "patch") {
      calls.push({
        key: part.id,
        name: "patch",
        status: "complete",
        target: part.files.length === 1 ? part.files[0] : `${String(part.files.length)} files`,
        resultDetail: (
          <CodeBlock
            code={part.files.join("\n")}
            language="plaintext"
            size="sm"
            width="100%"
            isWrapped
          />
        ),
      });
      continue;
    }
    flush();
    nodes.push(
      part.kind === "reasoning" ? (
        <ChatMessageBubble key={part.id} variant="ghost" width="100%">
          <Reasoning text={part.text} isStreaming={part.isStreaming} />
        </ChatMessageBubble>
      ) : (
        <ChatMessageBubble key={part.id} variant="ghost" width="100%">
          <Markdown density="compact" autolink="gfm">
            {part.text}
          </Markdown>
        </ChatMessageBubble>
      ),
    );
  }
  flush();
  return nodes;
}
