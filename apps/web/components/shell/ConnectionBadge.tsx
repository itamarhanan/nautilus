import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { connectionView } from "@/lib/connection";
import { useWorkspace } from "@/store";

export function ConnectionBadge() {
  const connection = useWorkspace((state) => state.connection);
  const online = useWorkspace((state) => state.online);
  if (online && connection.phase === "idle") return null;
  const view = connectionView(connection, online);

  return (
    <div
      className="flex shrink-0 items-center gap-2 whitespace-nowrap px-1"
      role="status"
      aria-live="polite"
    >
      <StatusDot
        variant={view.tone}
        label={view.label}
        tooltip={view.detail}
        isPulsing={connection.phase === "reconnecting"}
      />
      <Text type="supporting">{view.label}</Text>
    </div>
  );
}
