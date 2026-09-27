import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChatLayout, ChatMessageList } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Sparkles } from "lucide-react";
import { transcript } from "@nautilus/copy";
import { foldEvents, latestTodos, latestUsage, threadEvents, withLive } from "@/lib/transcript";
import type { Thread, TranscriptItem } from "@/lib/transcript";
import {
  buildThreads,
  canRetryTurn,
  hasOpenTodos,
  isRunning,
  isSessionWorking,
  lastModelId,
  showsMetadata,
  tabLabel,
  turnStartedAt,
  workingActivity,
} from "@/lib/session-view";
import { useOpenSessionRecord, useWorkspace } from "@/store";
import type { OpenSession } from "@/store/state";
import { Composer } from "./Composer";
import { SubagentStatus, SubagentsContext } from "./subagents";
import { SubagentThread } from "./SubagentThread";
import { TodoPanel } from "./TodoPanel";
import { TranscriptEntry } from "./TranscriptEntry";
import { WorkingIndicator } from "./WorkingIndicator";

export function SessionChat({ session, alerts }: { session: OpenSession; alerts: ReactNode }) {
  const record = useOpenSessionRecord();
  const isTurnPending = useWorkspace((state) => state.pending.turn !== null);
  const [viewing, setViewing] = useState<string | null>(null);
  const { events, streaming, outgoing } = session;

  const folded = useMemo(() => foldEvents(threadEvents(events, null)), [events]);
  const transcriptItems = useMemo(
    () => withLive(folded, { streaming, outgoing }),
    [folded, streaming, outgoing],
  );
  const todos = useMemo(() => latestTodos(events), [events]);
  const threads = useMemo(() => buildThreads(events, streaming), [events, streaming]);
  const threadList = useMemo(() => [...threads.values()], [threads]);
  const subagents = useMemo(() => ({ subagents: threads, open: setViewing }), [threads]);
  const usage = useMemo(() => latestUsage(transcriptItems), [transcriptItems]);
  const modelId = useMemo(() => lastModelId(transcriptItems), [transcriptItems]);

  const isWorking = isSessionWorking(record?.status, session.awaitingEvent);
  const canRetry = canRetryTurn(record?.status);
  const isDisabled = !record || !session.isSnapshotLoaded;
  const isSendBlocked = isDisabled || isWorking || isTurnPending;
  const viewed = viewing ? threads.get(viewing) : undefined;
  const activity = workingActivity(
    transcriptItems,
    threadList.filter((thread) => isRunning(thread.status)),
    todos,
  );

  return (
    <SubagentsContext.Provider value={subagents}>
      <div className="flex h-full min-h-0 flex-col">
        {threadList.length > 0 ? (
          <ThreadTabs
            threads={threadList}
            selected={viewed ? viewed.id : "main"}
            onSelect={setViewing}
          />
        ) : null}
        {viewed ? (
          <SubagentThread
            thread={viewed}
            onBack={() => {
              setViewing(null);
            }}
          />
        ) : (
          <ChatLayout
            className="min-h-0 flex-1"
            emptyState={
              <EmptyState
                icon={<Sparkles className="size-10 text-secondary" aria-hidden />}
                title={transcript.readyForInstruction}
                description="Describe one focused change. You can leave the app while the agent works; the reply is here when you come back."
              />
            }
            composer={
              <div className="flex flex-col gap-2">
                {todos.length > 0 && (isWorking || hasOpenTodos(todos)) ? (
                  <TodoPanel todos={todos} />
                ) : null}
                {alerts}
                <Composer
                  sessionId={session.id}
                  isDisabled={isDisabled}
                  isSendBlocked={isSendBlocked}
                  isWorking={isWorking}
                  canRetry={canRetry}
                  lastModelId={modelId}
                  usage={usage}
                />
              </div>
            }
          >
            <TranscriptBody items={transcriptItems} isWorking={isWorking} activity={activity} />
          </ChatLayout>
        )}
      </div>
    </SubagentsContext.Provider>
  );
}

function ThreadTabs({
  threads,
  selected,
  onSelect,
}: {
  threads: readonly Thread[];
  selected: string;
  onSelect: (value: string | null) => void;
}) {
  return (
    <TabList
      value={selected}
      onChange={(value) => {
        onSelect(value === "main" ? null : value);
      }}
      size="sm"
      hasDivider
      className="shrink-0 px-2"
    >
      <Tab value="main" label={transcript.mainThread} />
      {threads.map((thread) => (
        <Tab
          key={thread.id}
          value={thread.id}
          label={tabLabel(thread.title)}
          endContent={<SubagentStatus status={thread.status} />}
        />
      ))}
    </TabList>
  );
}

function TranscriptBody({
  items,
  isWorking,
  activity,
}: {
  items: readonly TranscriptItem[];
  isWorking: boolean;
  activity: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <ChatMessageList isStreaming={isWorking} density="balanced">
      {items.map((item, index) => (
        <TranscriptEntry
          key={item.key}
          item={item}
          hasMetadata={showsMetadata(items, index, isWorking)}
        />
      ))}
      {isWorking && activity ? (
        <WorkingIndicator activity={activity} since={turnStartedAt(items)} />
      ) : null}
    </ChatMessageList>
  );
}
