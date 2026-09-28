import { useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useApp } from "../context";
import { messageOf } from "../lib/errors";

export type RemoveTarget = {
  id: string;
  name: string;

  runnerOnly?: boolean;
};

export function RemoveProjectDialog({
  project,
  onClose,
}: {
  project: RemoveTarget | null;
  onClose: () => void;
}) {
  const removeProject = useApp((state) => state.removeProject);
  const notify = useApp((state) => state.notify);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useRef<string | null>(null);
  const projectId = project?.id ?? null;
  useEffect(() => {
    shown.current = projectId;
    return () => {
      shown.current = null;
    };
  }, [projectId]);

  const close = () => {
    setError(null);
    onClose();
  };

  const remove = async () => {
    if (!project || removing) return;
    setRemoving(true);
    setError(null);
    let message: string | null;
    try {
      message = await removeProject(project.id);
    } catch (caught) {
      message = messageOf(caught, "Could not remove the project");
    } finally {
      setRemoving(false);
    }
    if (message === null) {
      if (shown.current === project.id) close();
    } else if (shown.current === project.id) {
      setError(message);
    } else {
      notify({ tone: "error", title: `Could not remove ${project.name}`, body: message });
    }
  };

  const runnerOnly = project?.runnerOnly ?? false;
  const name = project?.name ?? "project";
  return (
    <Dialog
      isOpen={project !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width={440}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={runnerOnly ? `Remove ${name} from the runner?` : `Remove ${name}?`}
            onOpenChange={() => {
              close();
            }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text type="body" color="secondary">
                {runnerOnly
                  ? "The runner deletes its copy of this project and its agent history. This PC has no copy of it, so nothing here changes."
                  : "The runner deletes its copy and agent history for this project. Files on this PC are not touched, and the folder stays in Recent."}
              </Text>
              {error ? (
                <Banner
                  status="error"
                  title="Could not remove the project"
                  description={<span className="select-text">{error}</span>}
                />
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={close} data-autofocus />
              <Button
                label={error ? "Try again" : "Remove"}
                variant="destructive"
                isLoading={removing}
                onClick={() => void remove()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
