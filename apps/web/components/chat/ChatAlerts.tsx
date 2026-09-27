import { Banner } from "@astryxdesign/core/Banner";
import { useActions, useWorkspace } from "@/store";

type ChatAlertsProps = {
  projectError: string | null;
  onDismissProjectError: () => void;
};

export function ChatAlerts({ projectError, onDismissProjectError }: ChatAlertsProps) {
  const error = useWorkspace((state) => state.error);
  const { clearError } = useActions();
  if (!error && !projectError) return null;
  return (
    <div className="flex flex-col gap-2">
      {projectError ? (
        <Banner
          status="error"
          title="Project error"
          description={projectError}
          isDismissable
          onDismiss={onDismissProjectError}
        />
      ) : null}
      {error ? (
        <Banner
          status="error"
          title="Something went wrong"
          description={error}
          isDismissable
          onDismiss={clearError}
        />
      ) : null}
    </div>
  );
}
