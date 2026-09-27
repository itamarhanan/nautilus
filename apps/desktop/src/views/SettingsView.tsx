import { useEffect, useState } from "react";
import { brand } from "@nautilus/brand";
import type { DeviceResponse } from "@nautilus/types";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { VStack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Smartphone, Wand2 } from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { useApp } from "../context";
import type { SettingsSection } from "../store";
import { desktopPaths, readSshConfig } from "../lib/files";
import { readableStatus } from "@nautilus/copy";
import { activeDevices, plural } from "../lib/format";
import { detectLightningHost, type DesktopSettings, type SettingsErrors } from "../lib/settings";

declare const __APP_VERSION__: string;

export function SettingsView({ section }: { section: SettingsSection }) {
  const navigate = useApp((state) => state.navigate);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
      <Heading level={2} accessibilityLevel={1}>
        Settings
      </Heading>
      <TabList
        value={section}
        onChange={(value) => {
          navigate({ name: "settings", section: value as SettingsSection });
        }}
        hasDivider
        role="tablist"
      >
        <Tab value="runner" label="Runner" />
        <Tab value="search" label="Project search" />
        <Tab value="phones" label="Phones" />
        <Tab value="about" label="About" />
      </TabList>
      {section === "runner" ? <RunnerSettings /> : null}
      {section === "search" ? <ProjectSearchSettings /> : null}
      {section === "phones" ? <PhoneSettings /> : null}
      {section === "about" ? <About /> : null}
    </div>
  );
}

function useDraft() {
  const settings = useApp((state) => state.settings);
  const [draft, setDraft] = useState<DesktopSettings>(settings);
  useEffect(() => {
    setDraft(settings);
  }, [settings]);
  return [draft, setDraft] as const;
}

function fieldStatus(message: string | undefined) {
  return message ? { type: "error" as const, message } : undefined;
}

function RunnerSettings() {
  const localMode = useApp((state) => state.localMode);
  const saveSettings = useApp((state) => state.saveSettings);
  const connection = useApp((state) => state.connection);
  const settingsExist = useApp((state) => state.settingsExist);
  const [draft, setDraft] = useDraft();
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [detectMessage, setDetectMessage] = useState<string | null>(null);

  const update = (change: (draft: DesktopSettings) => DesktopSettings) => {
    setDraft((current) => change(current));
    setSaved(false);
  };

  const detect = async () => {
    const config = await readSshConfig(await desktopPaths()).catch(() => undefined);
    const found = config ? detectLightningHost(config) : undefined;
    if (found) {
      update((current) => ({
        ...current,
        ssh: { ...current.ssh, host: found.host, user: found.user },
      }));
      setDetectMessage(`Found ${found.user}@${found.host} in ~/.ssh/config.`);
    } else {
      setDetectMessage("No Lightning host in ~/.ssh/config. Run `lightning ssh configure` first.");
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    const result = await saveSettings(draft).finally(() => {
      setSaving(false);
    });
    if (result === null) {
      setErrors({});
      setSaved(true);
    } else if (result === "connection_failed") {
      setErrors({});
      setFailure("Could not connect with these settings, so they were not saved.");
    } else {
      setErrors(result);
    }
  };

  return (
    <Card padding={5}>
      <VStack gap={4}>
        {!settingsExist ? (
          <Banner
            status="info"
            title="Connect this PC to your runner"
            description="Nautilus reaches the runner over SSH with the key that `lightning ssh configure` created. No token or password is stored."
          />
        ) : null}
        {localMode ? (
          <Banner
            status="info"
            title="Local mode"
            description="The desktop talks to a runner on this machine, so the SSH settings are ignored."
          />
        ) : null}
        <TextInput
          label="Runner URL"
          description="The Studio's public Nautilus port. Used for the phone link."
          value={draft.runnerUrl}
          onChange={(value) => {
            update((current) => ({ ...current, runnerUrl: value }));
          }}
          placeholder="https://8080-01abc….cloudspaces.litng.ai"
          autoComplete="off"
          status={fieldStatus(errors.runnerUrl)}
          onEnter={() => void save()}
        />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextInput
              label="SSH user"
              description="The Studio user from `lightning ssh configure`."
              value={draft.ssh.user}
              onChange={(value) => {
                update((current) => ({
                  ...current,
                  ssh: { ...current.ssh, user: value },
                }));
              }}
              placeholder="s_01abc…"
              autoComplete="off"
              status={fieldStatus(errors.sshUser)}
              onEnter={() => void save()}
            />
          </div>
          <Button
            label="Detect"
            variant="secondary"
            icon={<Wand2 className="size-3.5" aria-hidden />}
            tooltip="Read the Lightning host from ~/.ssh/config"
            onClick={() => void detect()}
          />
        </div>
        {detectMessage ? <Text type="supporting">{detectMessage}</Text> : null}
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="SSH host"
            value={draft.ssh.host}
            onChange={(value) => {
              update((current) => ({
                ...current,
                ssh: { ...current.ssh, host: value },
              }));
            }}
            autoComplete="off"
            status={fieldStatus(errors.sshHost)}
            onEnter={() => void save()}
          />
          <TextInput
            label="SSH key"
            value={draft.ssh.keyPath}
            onChange={(value) => {
              update((current) => ({
                ...current,
                ssh: { ...current.ssh, keyPath: value },
              }));
            }}
            autoComplete="off"
            status={fieldStatus(errors.keyPath)}
            onEnter={() => void save()}
          />
        </div>
        {failure ? (
          <Banner
            status="error"
            title={failure}
            description={
              connection.error ? <span className="select-text">{connection.error}</span> : undefined
            }
          />
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {saved ? <Text type="supporting">Saved and connected.</Text> : null}
          <Button
            label={saving ? "Connecting…" : "Save and connect"}
            variant="primary"
            isLoading={saving}
            onClick={() => void save()}
          />
        </div>
      </VStack>
    </Card>
  );
}

function ProjectSearchSettings() {
  const saveProjectRoots = useApp((state) => state.saveProjectRoots);
  const scanning = useApp((state) => state.scanning);
  const scan = useApp((state) => state.scan);
  const scanned = useApp((state) => state.appState.scan);
  const roots = useApp((state) => state.settings.projectRoots);
  const [text, setText] = useState(roots.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setText(roots.join("\n"));
  }, [roots]);

  const parsed = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty = parsed.join("\n") !== roots.join("\n");

  const save = async () => {
    setSaving(true);
    try {
      setError(await saveProjectRoots(parsed));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the folders");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <Text color="secondary">
          Nautilus looks for projects (folders with .git, package.json, or a lockfile) up to three
          levels below these folders. One per line.
        </Text>
        <textarea
          aria-label="Project search folders"
          className="min-h-24 w-full resize-y rounded-md border border-border bg-surface p-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="~/Projects"
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && dirty) {
              event.preventDefault();
              void save();
            }
          }}
        />
        {error ? <Banner status="error" title={error} /> : null}
        <div className="flex items-center justify-between gap-3">
          <Text type="supporting">
            {scanning
              ? "Scanning…"
              : scanned
                ? `${plural(scanned.folders.length, "project")} found · scanned `
                : "Not scanned yet"}
            {!scanning && scanned ? (
              <Timestamp value={scanned.scannedAt} format="relative" />
            ) : null}
          </Text>
          <div className="flex gap-2">
            <Button
              label="Scan now"
              variant="secondary"
              isLoading={scanning}
              onClick={() => void scan(true)}
            />
            <Button
              label="Save"
              variant="primary"
              isLoading={saving}
              isDisabled={!dirty}
              tooltip={dirty ? undefined : "No changes to save"}
              onClick={() => void save()}
            />
          </div>
        </div>
      </VStack>
    </Card>
  );
}

function PhoneSettings() {
  const devices = useApp((state) => state.devices);
  const connected = useApp((state) => state.connection.phase === "connected");
  const refreshDevices = useApp((state) => state.refreshDevices);
  const revokeDevice = useApp((state) => state.revokeDevice);
  const setLinkPhoneOpen = useApp((state) => state.setLinkPhoneOpen);
  const [revoking, setRevoking] = useState<DeviceResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const active = activeDevices(devices);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <div className="flex items-center justify-between gap-3">
          <Text color="secondary">A linked phone can use every project on the runner.</Text>
          <Button
            label="Link phone"
            variant="primary"
            size="sm"
            isDisabled={!connected}
            onClick={() => {
              setLinkPhoneOpen(true);
            }}
          />
        </div>
        {active.length === 0 ? (
          <Text type="supporting">No phones linked.</Text>
        ) : (
          <List hasDividers>
            {active.map((device) => (
              <ListItem
                key={device.id}
                label={device.name}
                startContent={<Smartphone className="size-4 text-secondary" aria-hidden />}
                description={
                  device.lastSeenAt ? (
                    <>
                      Last seen <Timestamp value={device.lastSeenAt} format="relative" />
                    </>
                  ) : (
                    <>
                      Linked <Timestamp value={device.createdAt} format="relative" />
                    </>
                  )
                }
                endContent={
                  <Button
                    label="Revoke"
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setRevoking(device);
                    }}
                  />
                }
              />
            ))}
          </List>
        )}
      </VStack>
      <AlertDialog
        isOpen={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.name ?? "phone"}?`}
        description="The phone loses access right away and must be linked again with a new code."
        actionLabel="Revoke"
        isActionLoading={busy}
        onAction={async () => {
          if (!revoking) return;
          setBusy(true);
          await revokeDevice(revoking.id);
          setBusy(false);
          setRevoking(null);
        }}
      />
    </Card>
  );
}

function About() {
  const info = useApp((state) => state.connection.info);
  const agent = useApp((state) => state.agent);
  return (
    <Card padding={5}>
      <div className="mb-5 flex items-center gap-4">
        <BrandMark size={56} />
        <div className="flex flex-col gap-0.5">
          <Heading level={3} accessibilityLevel={2}>
            {brand.name}
          </Heading>
          <Text type="supporting">{brand.tagline}</Text>
        </div>
      </div>
      <MetadataList label={{ position: "start", width: 140 }}>
        <MetadataListItem label="Desktop app">{__APP_VERSION__}</MetadataListItem>
        <MetadataListItem label="Runner">
          {info ? `${info.service} ${info.version}` : "Not connected"}
        </MetadataListItem>
        <MetadataListItem label="Runner state">
          {info ? readableStatus(info.lifecycle.state) : "—"}
        </MetadataListItem>
        <MetadataListItem label="Sync agent">{readableStatus(agent.phase)}</MetadataListItem>
        <MetadataListItem label="Settings file">
          <Text type="code" className="select-text">
            ~/.nautilus/config.json
          </Text>
        </MetadataListItem>
      </MetadataList>
    </Card>
  );
}
