import type { ReactNode } from "react";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import type { LucideIcon } from "lucide-react";

type CenteredEmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
};

export function CenteredEmptyState({ icon: Icon, ...props }: CenteredEmptyStateProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState icon={<Icon className="size-10 text-secondary" aria-hidden />} {...props} />
    </div>
  );
}
