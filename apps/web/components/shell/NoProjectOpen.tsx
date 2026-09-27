import { Button } from "@astryxdesign/core/Button";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { FolderGit2 } from "lucide-react";
import { CenteredEmptyState } from "../common/CenteredEmptyState";

export function NoProjectOpen({ hasProjects }: { hasProjects: boolean }) {
  const { isMobile, openMobileNav } = useAppShellMobile();
  if (!hasProjects) {
    return (
      <CenteredEmptyState
        headingLevel={1}
        icon={FolderGit2}
        title="No projects yet"
        description="Add a project from Nautilus on your PC. It appears here as soon as it is added."
      />
    );
  }
  return (
    <CenteredEmptyState
      headingLevel={1}
      icon={FolderGit2}
      title="Choose a project"
      description={
        isMobile
          ? "Open the project list to pick one."
          : "Pick a project from the menu. Nothing starts until you select one."
      }
      actions={
        isMobile ? (
          <Button label="Show projects" variant="primary" onClick={openMobileNav} />
        ) : undefined
      }
    />
  );
}
