import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Copy, Trash2 } from "lucide-react";
import { EnvironmentCard } from "../components/EnvironmentCard";
import { useApp } from "../context";
import { readableStatus } from "@nautilus/copy";
import type { StateProject } from "../lib/state";
import { RemoveProjectDialog } from "../overlays/RemoveProjectDialog";

export function ProjectSettings({ project }: { project: StateProject }) {
  const record = useApp((state) => state.projects.find((entry) => entry.id === project.id));
  const notify = useApp((state) => state.notify);
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <>
      <GeneralForm key={project.id} project={project} />

      <EnvironmentCard key={`env-${project.id}`} projectId={project.id} />

      <Card padding={5}>
        <MetadataList label={{ position: "start", width: 120 }}>
          <MetadataListItem label="Folder">
            <div className="flex min-w-0 items-center gap-2">
              <Text type="code" wordBreak="break-all" className="select-text">
                {project.localPath}
              </Text>
              <Button
                label="Copy path"
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" aria-hidden />}
                onClick={() => {
                  void navigator.clipboard.writeText(project.localPath).then(() => {
                    notify({ tone: "info", title: "Path copied", body: project.localPath });
                  });
                }}
              />
            </div>
          </MetadataListItem>
          <MetadataListItem label="Project id">
            <Text type="code" className="select-text">
              {project.id}
            </Text>
          </MetadataListItem>
          <MetadataListItem label="Added">
            <Timestamp value={project.addedAt} format="relative" />
          </MetadataListItem>
          <MetadataListItem label="On the runner">
            {record ? readableStatus(record.state) : "Not registered"}
          </MetadataListItem>
        </MetadataList>
      </Card>

      <section className="flex flex-col gap-2">
        <Heading level={4} accessibilityLevel={2}>
          Remove project
        </Heading>
        <div className="flex items-center justify-between gap-4">
          <Text type="supporting">
            The runner deletes its copy and agent history. Files on this PC stay as they are.
          </Text>
          <Button
            label="Remove…"
            variant="destructive"
            size="sm"
            icon={<Trash2 className="size-3.5" aria-hidden />}
            onClick={() => {
              setConfirmRemove(true);
            }}
          />
        </div>
      </section>

      <RemoveProjectDialog
        project={confirmRemove ? project : null}
        onClose={() => {
          setConfirmRemove(false);
        }}
      />
    </>
  );
}

function GeneralForm({ project }: { project: StateProject }) {
  const updateProject = useApp((state) => state.updateProject);
  const connected = useApp((state) => state.connection.phase === "connected");
  const [name, setName] = useState(project.name);
  const [devCommand, setDevCommand] = useState(project.devCommand);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== project.name || devCommand.trim() !== project.devCommand;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      setError(await updateProject(project.id, { name, devCommand }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <TextInput
          label="Name"
          value={name}
          onChange={setName}
          autoComplete="off"
          onEnter={() => void save()}
        />
        <TextInput
          label="Dev command"
          description="Runs on the runner to serve the preview. No shell operators. A running dev server picks it up on its next start."
          value={devCommand}
          onChange={setDevCommand}
          autoComplete="off"
          onEnter={() => void save()}
        />
        {error ? <Banner status="error" title="Could not save" description={error} /> : null}
        <div className="flex items-center justify-end gap-2">
          {dirty ? (
            <Button
              label="Discard"
              variant="ghost"
              isDisabled={saving}
              onClick={() => {
                setName(project.name);
                setDevCommand(project.devCommand);
                setError(null);
              }}
            />
          ) : null}
          <Button
            label="Save"
            variant="primary"
            isLoading={saving}
            isDisabled={!dirty || !connected}
            tooltip={connected ? undefined : "Connect to the runner first"}
            onClick={() => void save()}
          />
        </div>
      </VStack>
    </Card>
  );
}
