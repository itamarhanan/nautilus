import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useApp } from "../context";
import type { StateProject } from "../lib/state";

export function RemoveProjectDialog({
  project,
  onClose,
}: {
  project: StateProject | null;
  onClose: () => void;
}) {
  const removeProject = useApp((state) => state.removeProject);
  const [removing, setRemoving] = useState(false);
  return (
    <AlertDialog
      isOpen={project !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Remove ${project?.name ?? "project"}?`}
      description="The runner deletes its copy and agent history for this project. Files on this PC are not touched, and the folder stays in Recent."
      actionLabel="Remove"
      isActionLoading={removing}
      onAction={async () => {
        if (!project) return;
        setRemoving(true);
        try {
          await removeProject(project.id);
        } finally {
          setRemoving(false);
          onClose();
        }
      }}
    />
  );
}
