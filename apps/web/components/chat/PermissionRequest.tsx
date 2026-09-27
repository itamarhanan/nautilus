import { Button } from "@astryxdesign/core/Button";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { permission } from "@nautilus/copy";
import type { PermissionResponse, TranscriptItem } from "@/lib/transcript";
import { useActions, useWorkspace } from "@/store";

type PermissionItem = Extract<TranscriptItem, { kind: "permission" }>;

const ANSWERED: Record<PermissionResponse, { label: string; icon: typeof ShieldCheck }> = {
  once: { label: "Allowed once", icon: ShieldCheck },
  always: { label: "Always allowed", icon: ShieldCheck },
  reject: { label: "Denied", icon: ShieldX },
};

export function PermissionRequest({ item }: { item: PermissionItem }) {
  const pending = useWorkspace((state) => state.pending.permission);
  const { respondToPermission } = useActions();
  const label = permission.label[item.permission] ?? permission.unknown(item.permission);

  if (item.response) {
    const answered = ANSWERED[item.response];
    const Icon = answered.icon;
    return (
      <div className="flex items-center justify-center gap-1.5 py-1 text-secondary">
        <Icon className="size-3.5" aria-hidden />
        <Text type="supporting">
          {answered.label}: {label.toLowerCase()}
        </Text>
      </div>
    );
  }

  const isAnswering = pending === item.id;
  const answer = (response: PermissionResponse) => {
    void respondToPermission(item.id, response);
  };
  return (
    <ChatMessage sender="assistant">
      <ChatMessageBubble variant="ghost" width="100%">
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1">
              <Text weight="semibold">The agent is asking to {label.toLowerCase()}</Text>
              {item.patterns.length > 0 ? (
                <code className="block break-all whitespace-pre-wrap text-sm text-secondary">
                  {item.patterns.join("\n")}
                </code>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              label="Allow once"
              size="sm"
              isLoading={isAnswering}
              isDisabled={pending !== null}
              onClick={() => {
                answer("once");
              }}
            />
            <Button
              label="Always allow"
              size="sm"
              variant="secondary"
              tooltip="Allow this kind of request for the rest of the session"
              isDisabled={pending !== null}
              onClick={() => {
                answer("always");
              }}
            />
            <Button
              label="Deny"
              size="sm"
              variant="secondary"
              isDisabled={pending !== null}
              onClick={() => {
                answer("reject");
              }}
            />
          </div>
        </div>
      </ChatMessageBubble>
    </ChatMessage>
  );
}
