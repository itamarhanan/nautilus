import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { ChevronRight } from "lucide-react";
import { createContext, useContext } from "react";
import { subagentCardView, type SubagentCardView } from "@/lib/subagent-view";
import { toolStatusView } from "@/lib/status";
import type { SubagentSummary, ToolCall, ToolStatus } from "@/lib/transcript";

type SubagentsValue = {
  subagents: ReadonlyMap<string, SubagentSummary>;
  open: (id: string) => void;
};

export const SubagentsContext = createContext<SubagentsValue>({
  subagents: new Map(),
  open: () => undefined,
});

export function SubagentStatus({ status }: { status: ToolStatus }) {
  const view = toolStatusView(status);
  if (view.isBusy) return <Spinner size="sm" aria-label="Subagent working" />;
  return <StatusDot variant={view.tone} label={view.label} />;
}

export function SubagentCard({ call }: { call: ToolCall }) {
  const { subagents, open } = useContext(SubagentsContext);
  const id = call.subagent?.sessionId ?? null;
  const view = subagentCardView(call, id ? subagents.get(id) : undefined);
  const body = <SubagentBody view={view} />;
  const className =
    "flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-start";

  if (!id) return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      className={`${className} cursor-pointer hover:bg-tint-hover`}
      aria-label={`Open subagent: ${view.title}`}
      onClick={() => {
        open(id);
      }}
    >
      {body}
    </button>
  );
}

function SubagentBody({ view }: { view: SubagentCardView }) {
  return (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <SubagentStatus status={view.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Text weight="semibold" maxLines={1} hasTruncateTooltip={false}>
          {view.title}
        </Text>
        <Text type="supporting" maxLines={1} hasTruncateTooltip={false}>
          <SubagentDetailLine agentType={view.agentType} detail={view.detail} />
        </Text>
      </span>
      {view.isOpenable ? (
        <ChevronRight className="size-4 shrink-0 text-secondary" aria-hidden />
      ) : null}
    </>
  );
}

function SubagentDetailLine({ agentType, detail }: { agentType: string | null; detail: string }) {
  return <>{agentType ? `${agentType} · ${detail}` : detail}</>;
}
