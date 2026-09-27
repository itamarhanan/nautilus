import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useApp } from "../context";
import type { FolderCandidate } from "../lib/folders";
import { suggestedDevCommand } from "../store";

export function AddProjectDialog({
  folder,
  onClose,
}: {
  folder: FolderCandidate | null;
  onClose: () => void;
}) {
  const addProject = useApp((state) => state.addProject);
  const connected = useApp((state) => state.connection.phase === "connected");
  const [name, setName] = useState("");
  const [devCommand, setDevCommand] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!folder) return;
    setName(folder.name);
    setDevCommand(suggestedDevCommand(folder));
    setError(null);
  }, [folder]);

  const canSubmit = connected && devCommand.trim() !== "" && !saving;

  const submit = async () => {
    if (!folder || !canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await addProject({
        folder,
        name: name.trim() || folder.name,
        devCommand: devCommand.trim(),
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add the project");
    } finally {
      setSaving(false);
    }
  };

  const detected = folder
    ? [
        folder.git ? "Git" : null,
        folder.packageManager,
        folder.devScript ? `"${folder.devScript}" script` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Dialog
      isOpen={folder !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="form"
      width={480}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="Add project"
            subtitle={folder?.path}
            onOpenChange={() => {
              onClose();
            }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text type="supporting">
                {detected ? `Detected: ${detected}` : "No package manager or git detected."}
              </Text>
              <TextInput
                label="Name"
                value={name}
                onChange={setName}
                hasAutoFocus
                autoComplete="off"
                onEnter={() => void submit()}
              />
              <TextInput
                label="Dev command"
                description="Runs on the runner to serve the preview. No shell operators."
                value={devCommand}
                onChange={setDevCommand}
                autoComplete="off"
                onEnter={() => void submit()}
              />
              {!connected ? (
                <Banner
                  status="warning"
                  title="Not connected to the runner"
                  description="The project is registered on the runner, so connect first. Your edits here are kept."
                />
              ) : null}
              {error ? (
                <Banner status="error" title="Could not add the project" description={error} />
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label="Add project"
                variant="primary"
                isLoading={saving}
                isDisabled={!connected || !devCommand.trim()}
                onClick={() => void submit()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
