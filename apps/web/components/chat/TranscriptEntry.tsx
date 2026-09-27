import { memo } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
} from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { TranscriptItem } from "@/lib/transcript";
import { usageSummary } from "@/lib/usage";
import { useWorkspace } from "@/store";
import { renderParts } from "./parts";
import { PermissionRequest } from "./PermissionRequest";
import { TurnChanges } from "./TurnChanges";

const NOTICE_ICON = {
  info: <Info className="size-3.5" aria-hidden />,
  warning: <TriangleAlert className="size-3.5 text-warning" aria-hidden />,
  error: <CircleAlert className="size-3.5 text-error" aria-hidden />,
};

type TranscriptEntryProps = {
  item: TranscriptItem;
  hasMetadata?: boolean;
};

export const TranscriptEntry = memo(function TranscriptEntry({
  item,
  hasMetadata = true,
}: TranscriptEntryProps) {
  const time = <Timestamp value={item.timestamp} format="time" />;
  switch (item.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble
            metadata={
              <ChatMessageMetadata
                timestamp={time}
                status={item.isPending ? "sending" : undefined}
              />
            }
          >
            <span
              className={`whitespace-pre-wrap break-words${item.isPending ? " opacity-70" : ""}`}
            >
              {item.text}
            </span>
          </ChatMessageBubble>
        </ChatMessage>
      );
    case "assistant":
      return (
        <ChatMessage
          sender="assistant"
          metadata={
            hasMetadata ? (
              <ChatMessageMetadata timestamp={time} footer={<TurnFooter item={item} />} />
            ) : undefined
          }
        >
          {renderParts(item.parts)}
          {item.error ? (
            <ChatMessageBubble variant="ghost" width="100%">
              <Banner status="error" title="Turn failed" description={item.error} />
            </ChatMessageBubble>
          ) : null}
        </ChatMessage>
      );
    case "notice":
      return <ChatSystemMessage icon={NOTICE_ICON[item.tone]}>{item.text}</ChatSystemMessage>;
    case "permission":
      return <PermissionRequest item={item} />;
    case "checkpoint":
      return <TurnChanges item={item} />;
  }
});

function TurnFooter({ item }: { item: Extract<TranscriptItem, { kind: "assistant" }> }) {
  const name = useWorkspace(
    (state) => state.models.models.find((model) => model.modelId === item.model)?.name,
  );
  const details = [name ?? item.model, item.turnUsage ? usageSummary(item.turnUsage) : null].filter(
    (detail) => detail !== null,
  );
  if (details.length === 0) return null;
  return <Text type="supporting">{details.join(" · ")}</Text>;
}
