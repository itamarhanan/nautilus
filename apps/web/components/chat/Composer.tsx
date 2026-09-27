import type { KeyboardEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ChatComposer, ChatComposerInput, ChatSendButton } from "@astryxdesign/core/Chat";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { RotateCcw } from "lucide-react";
import { requestAlertPermission } from "@/lib/alerts";
import { insertLineBreak } from "@/lib/browser";
import type { Usage } from "@/lib/transcript";
import { useActions, useWorkspace } from "@/store";
import { ContextMeter, EffortPicker, ModelPicker } from "./ModelPicker";

type ComposerProps = {
  sessionId: string;

  isDisabled: boolean;

  isSendBlocked: boolean;

  isWorking: boolean;
  canRetry: boolean;
  lastModelId: string | null;

  usage: Usage | null;
};

export function Composer({
  sessionId,
  isDisabled,
  isSendBlocked,
  isWorking,
  canRetry,
  lastModelId,
  usage,
}: ComposerProps) {
  const draft = useWorkspace((state) => state.drafts[sessionId] ?? "");
  const isRetrying = useWorkspace((state) => state.pending.turn === "retry");
  const { sendPrompt, retrySession, interruptSession, setDraft } = useActions();

  const isTouch = useMediaQuery("(pointer: coarse)");
  const updateDraft = (text: string) => {
    setDraft(sessionId, text);
  };

  const submit = async (value: string) => {
    requestAlertPermission();

    if (!(await sendPrompt(value))) updateDraft(value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (isTouch) {
      event.preventDefault();
      insertLineBreak(event.currentTarget);
    } else if (isSendBlocked) {
      event.preventDefault();
    }
  };

  const placeholder = isDisabled
    ? "Loading session…"
    : isWorking
      ? "Draft your next instruction…"
      : "Tell the agent what to build…";

  return (
    <ChatComposer
      value={draft}
      onChange={updateDraft}
      onSubmit={(value) => void submit(value)}
      isDisabled={isDisabled}
      isStopShown={isWorking}
      onStop={() => void interruptSession()}
      input={
        <ChatComposerInput
          label="Instruction for the agent"
          placeholder={placeholder}
          maxRows={8}
          isDisabled={isDisabled}
          onKeyDown={handleKeyDown}
        />
      }
      sendButton={<ChatSendButton isDisabled={isSendBlocked || !draft.trim()} />}
      footerActions={
        <div className="flex min-w-0 items-center gap-1">
          <ModelPicker isDisabled={isDisabled} lastModelId={lastModelId} />
          <EffortPicker isDisabled={isDisabled} lastModelId={lastModelId} />
          <ContextMeter lastModelId={lastModelId} usage={usage} />
          {canRetry ? (
            <Button
              label="Retry"
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3.5" aria-hidden />}
              tooltip="Run the last instruction again"
              isLoading={isRetrying}
              clickAction={retrySession}
            />
          ) : null}
        </div>
      }
      status={
        canRetry
          ? {
              type: "warning",
              message: "The last turn stopped before it finished.",
            }
          : undefined
      }
      statusPosition="top"
    />
  );
}
