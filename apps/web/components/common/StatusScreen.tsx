import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { CloudOff } from "lucide-react";
import { BrandMark } from "./BrandMark";

type StatusScreenProps = {
  title: string;
  description?: string;
  isLoading?: boolean;
  onRetry?: () => Promise<void>;
};

export function StatusScreen({
  title,
  description,
  isLoading = false,
  onRetry,
}: StatusScreenProps) {
  return (
    <main
      className="flex min-h-full flex-col items-center justify-center gap-6 bg-body p-6"
      aria-busy={isLoading}
    >
      {isLoading ? (
        <>
          <BrandMark size={48} />
          <Spinner size="lg" label={title} />
        </>
      ) : (
        <EmptyState
          headingLevel={1}
          icon={<CloudOff className="size-10 text-secondary" aria-hidden />}
          title={title}
          description={description}
          actions={
            onRetry ? (
              <Button label="Try again" variant="primary" clickAction={onRetry} />
            ) : undefined
          }
        />
      )}
    </main>
  );
}
