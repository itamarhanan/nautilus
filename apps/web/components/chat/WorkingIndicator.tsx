import { useEffect, useState } from "react";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { formatElapsed } from "@/lib/session-view";

function useElapsedSeconds(since: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [since]);
  if (!since) return null;
  return Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
}

export function WorkingIndicator({ activity, since }: { activity: string; since: string | null }) {
  const elapsed = useElapsedSeconds(since);
  return (
    <ChatMessage sender="assistant">
      <ChatMessageBubble variant="ghost">
        <span className="inline-flex min-w-0 items-center gap-2">
          <Spinner size="sm" aria-label="Agent working" />
          <Text type="supporting" maxLines={1} hasTruncateTooltip={false}>
            {activity}…
          </Text>
          {elapsed !== null && elapsed >= 3 ? (
            <Text type="supporting" hasTabularNumbers className="shrink-0">
              {formatElapsed(elapsed)}
            </Text>
          ) : null}
        </span>
      </ChatMessageBubble>
    </ChatMessage>
  );
}
