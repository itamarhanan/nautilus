import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { ArrowLeft } from "lucide-react";
import { isRunning, showsMetadata } from "@/lib/session-view";
import type { Thread } from "@/lib/transcript";
import { subagent as subagentCopy } from "@nautilus/copy";
import { TranscriptEntry } from "./TranscriptEntry";
import { WorkingIndicator } from "./WorkingIndicator";

export function SubagentThread({ thread, onBack }: { thread: Thread; onBack: () => void }) {
  const isActive = isRunning(thread.status);
  return (
    <ChatLayout
      className="min-h-0 flex-1"
      composer={
        <div className="flex min-w-0 items-center gap-3">
          <Button
            label="Main thread"
            variant="secondary"
            size="sm"
            icon={<ArrowLeft className="size-3.5" aria-hidden />}
            clickAction={onBack}
          />
          <Text type="supporting" maxLines={1} hasTruncateTooltip={false}>
            {thread.agentType ? subagentCopy.byAgent(thread.agentType) : subagentCopy.title} ·
            started by the main agent
          </Text>
        </div>
      }
    >
      <ChatMessageList isStreaming={isActive} density="balanced">
        {thread.prompt ? <Brief text={thread.prompt} /> : null}
        {thread.items.map((item, index) => (
          <TranscriptEntry
            key={item.key}
            item={item}
            hasMetadata={showsMetadata(thread.items, index, isActive)}
          />
        ))}
        {isActive && thread.activity ? (
          <WorkingIndicator activity={thread.activity} since={null} />
        ) : null}
        {thread.status === "error" ? (
          <ChatMessage sender="assistant">
            <ChatMessageBubble variant="ghost" width="100%">
              <Banner
                status="error"
                title={subagentCopy.stoppedTitle}
                description={thread.error ?? subagentCopy.stoppedDetail}
              />
            </ChatMessageBubble>
          </ChatMessage>
        ) : null}
      </ChatMessageList>
    </ChatLayout>
  );
}

function Brief({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <ChatMessage sender="user">
      <ChatMessageBubble>
        <button
          type="button"
          className="flex w-full cursor-pointer flex-col gap-1 text-start"
          aria-expanded={isExpanded}
          onClick={() => {
            setIsExpanded((current) => !current);
          }}
        >
          <Text type="supporting" weight="medium">
            {subagentCopy.fromMainAgent}
          </Text>
          <Text
            maxLines={isExpanded ? undefined : 6}
            hasTruncateTooltip={false}
            className="whitespace-pre-wrap break-words"
          >
            {text}
          </Text>
        </button>
      </ChatMessageBubble>
    </ChatMessage>
  );
}
