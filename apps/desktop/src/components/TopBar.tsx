import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Kbd } from "@astryxdesign/core/Kbd";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import type { DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Popover } from "@astryxdesign/core/Popover";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Check, Plus, RefreshCw, Settings, Smartphone } from "lucide-react";
import { useApp } from "../context";
import { homeRoute, type ProjectTab, type SettingsSection } from "../store";
import {
  activeDevices,
  agentLabel,
  connectionLabel,
  connectionTone,
  pendingChanges,
  plural,
} from "../lib/format";
import { BrandMark } from "./BrandMark";

const TAB_LABEL: Record<ProjectTab, string> = {
  overview: "Overview",
  settings: "Project settings",
};

const SECTION_LABEL: Record<SettingsSection, string> = {
  runner: "Runner",
  search: "Project search",
  phones: "Phones",
  about: "About",
};

export function TopBar() {
  const route = useApp((state) => state.route);
  const navigate = useApp((state) => state.navigate);
  const goUp = useApp((state) => state.goUp);
  const onSettings = route.name === "settings";
  return (
    <TopNav
      label="Nautilus"
      heading={
        <button
          type="button"
          aria-label="Home"
          className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-overlay-hover"
          onClick={() => {
            navigate(homeRoute);
          }}
        >
          <BrandMark size={24} />
          <span className="text-base font-semibold">Nautilus</span>
        </button>
      }
      startContent={<Trail />}
      endContent={
        <div className="flex items-center gap-1">
          <ConnectionPill />
          <PhoneButton />
          <IconButton
            label="Settings"
            tooltip={onSettings ? "Close settings" : "Settings"}
            variant={onSettings ? "secondary" : "ghost"}
            aria-pressed={onSettings}
            icon={<Settings className="size-4" aria-hidden />}
            onClick={() => {
              if (onSettings) goUp();
              else navigate({ name: "settings", section: "runner" });
            }}
          />
        </div>
      }
    />
  );
}

function Trail() {
  const route = useApp((state) => state.route);
  const projects = useApp((state) => state.appState.projects);
  const selectedId = useApp((state) => state.selectedProjectId);
  const status = useApp((state) => state.status);
  const selectProject = useApp((state) => state.selectProject);
  const setPaletteOpen = useApp((state) => state.setPaletteOpen);
  const navigate = useApp((state) => state.navigate);
  const selected = projects.find((project) => project.id === selectedId);

  if (route.name === "home") return null;
  if (route.name === "settings") {
    return (
      <Breadcrumbs label="Location">
        <BreadcrumbItem
          onClick={() => {
            navigate({ name: "settings", section: "runner" });
          }}
        >
          Settings
        </BreadcrumbItem>
        <BreadcrumbItem isCurrent>{SECTION_LABEL[route.section]}</BreadcrumbItem>
      </Breadcrumbs>
    );
  }
  if (!selected) return null;

  const menu: DropdownMenuOption[] = [
    ...projects.map((project, index) => {
      const pending = pendingChanges(status[project.id]);
      return {
        id: project.id,
        label: project.name,
        description: project.localPath,
        endContent: (
          <span className="flex items-center gap-2">
            {project.id === selectedId ? <Check className="size-4" aria-label="Current" /> : null}
            {pending > 0 ? <Badge variant="info" label={String(pending)} /> : null}
            {index < 9 ? <Kbd keys={`mod+${String(index + 1)}`} /> : null}
          </span>
        ),
        onClick: () => {
          selectProject(project.id);
        },
      };
    }),
    { type: "divider" },
    {
      id: "add",
      label: "Add project…",
      icon: <Plus className="size-4" aria-hidden />,
      endContent: <Kbd keys="mod+k" />,
      onClick: () => {
        setPaletteOpen(true);
      },
    },
  ];

  return (
    <Breadcrumbs label="Location">
      <BreadcrumbItem menu={menu} isCurrent={route.tab === "overview"}>
        {selected.name}
      </BreadcrumbItem>
      {route.tab === "overview" ? null : (
        <BreadcrumbItem isCurrent>{TAB_LABEL[route.tab]}</BreadcrumbItem>
      )}
    </Breadcrumbs>
  );
}

function ConnectionPill() {
  const connection = useApp((state) => state.connection);
  const agent = useApp((state) => state.agent);
  const settings = useApp((state) => state.settings);
  const localMode = useApp((state) => state.localMode);
  const reconnect = useApp((state) => state.reconnect);
  const [open, setOpen] = useState(false);
  const tone = connectionTone(connection.phase, agent.phase);
  const label = connectionLabel(connection.phase, agent.phase);

  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      label="Connection"
      placement="below"
      alignment="end"
      width={340}
      content={
        <VStack gap={3} padding={1}>
          <MetadataList label={{ position: "start", width: 96 }}>
            <MetadataListItem label="Runner">
              <Text type="code" wordBreak="break-all" className="select-text">
                {localMode ? "127.0.0.1 (local mode)" : settings.runnerUrl || "Not set"}
              </Text>
            </MetadataListItem>
            <MetadataListItem label="Control">
              {connection.phase === "connected"
                ? `Connected over SSH${connection.info ? ` · v${connection.info.version}` : ""}`
                : connectionLabel(connection.phase, "running")}
            </MetadataListItem>
            <MetadataListItem label="Sync agent">{agentLabel(agent.phase)}</MetadataListItem>
          </MetadataList>
          {connection.error && connection.phase !== "connected" ? (
            <Text type="supporting" color="secondary" className="select-text">
              {connection.error}
            </Text>
          ) : null}
          {agent.error ? (
            <Text type="supporting" color="secondary" className="select-text">
              {agent.error}
            </Text>
          ) : null}
          {tone !== "success" ? (
            <Button
              label="Reconnect"
              size="sm"
              variant="secondary"
              icon={<RefreshCw className="size-3.5" aria-hidden />}
              onClick={() => {
                reconnect();
              }}
            />
          ) : null}
        </VStack>
      }
    >
      <button
        type="button"
        className="flex h-8 items-center gap-2 rounded-full px-3 text-sm hover:bg-overlay-hover"
        aria-label={`Connection: ${label}`}
      >
        <StatusDot variant={tone} label={label} isPulsing={tone === "accent"} />
        <span>{label}</span>
      </button>
    </Popover>
  );
}

function PhoneButton() {
  const devices = useApp((state) => state.devices);
  const connected = useApp((state) => state.connection.phase === "connected");
  const setLinkPhoneOpen = useApp((state) => state.setLinkPhoneOpen);
  const active = activeDevices(devices).length;
  return (
    <Button
      label={active > 0 ? String(active) : "Link phone"}
      variant="ghost"
      size="sm"
      isDisabled={!connected}
      tooltip={
        !connected
          ? "Connect to the runner to link a phone"
          : active > 0
            ? `${plural(active, "linked phone")} · link another`
            : "Show a QR code for your phone"
      }
      icon={<Smartphone className="size-4" aria-hidden />}
      onClick={() => {
        setLinkPhoneOpen(true);
      }}
    />
  );
}
