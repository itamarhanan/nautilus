import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ActivityList } from "../components/ActivityList";
import { SyncCard } from "../components/SyncCard";
import { useApp } from "../context";
import { isUnconfigured, projectAttention } from "../lib/format";
import type { StateProject } from "../lib/state";
import type { ProjectTab } from "../store";
import { ProjectSettings } from "./ProjectSettings";

const TABS: { value: ProjectTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "settings", label: "Settings" },
];

export function ProjectView({ project, tab }: { project: StateProject; tab: ProjectTab }) {
  const record = useApp((state) => state.projects.find((entry) => entry.id === project.id));
  const navigate = useApp((state) => state.navigate);
  const attention = projectAttention(record);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <Heading level={2} accessibilityLevel={1} maxLines={1}>
                  {project.name}
                </Heading>
                {attention ? <Badge variant={attention.variant} label={attention.label} /> : null}
              </div>
              <Text type="code" size="xsm" color="secondary" maxLines={1} className="select-text">
                {project.devCommand}
              </Text>
            </div>
          </div>
        </div>
        <TabList
          value={tab}
          onChange={(value) => {
            navigate({ name: "project", tab: value as ProjectTab });
          }}
          hasDivider
        >
          {TABS.map((entry) => (
            <Tab key={entry.value} value={entry.value} label={entry.label} />
          ))}
        </TabList>
      </header>

      {tab === "overview" ? <Overview project={project} /> : <ProjectSettings project={project} />}
    </div>
  );
}

function Overview({ project }: { project: StateProject }) {
  const record = useApp((state) => state.projects.find((entry) => entry.id === project.id));
  const connected = useApp((state) => state.connection.phase === "connected");
  const history = useApp((state) => state.history[project.id]);
  const statusError = useApp((state) => state.status[project.id]?.error ?? null);
  const statusErrorCode = useApp((state) => state.status[project.id]?.errorCode ?? null);
  const agent = useApp((state) => state.agent);
  const reregister = useApp((state) => state.reregisterProject);
  const reconnect = useApp((state) => state.reconnect);
  const attention = projectAttention(record);

  const unconfigured = isUnconfigured(statusErrorCode);

  return (
    <>
      {agent.phase === "error" && agent.error ? (
        <Banner
          status="error"
          title="The sync agent is not running"
          description={agent.error}
          endContent={<Button label="Restart" size="sm" variant="secondary" onClick={reconnect} />}
        />
      ) : null}
      {connected && (!record || unconfigured) ? (
        <Banner
          status="warning"
          title="The runner does not have this project"
          description="The runner was reset or the project was removed there. Register it again, then push."
          endContent={
            <Button
              label="Register again"
              size="sm"
              variant="secondary"
              onClick={() => void reregister(project.id)}
            />
          }
        />
      ) : null}
      {record?.lastError && attention ? (
        <Banner
          status="warning"
          title="The runner reported a problem"
          description={<span className="select-text">{record.lastError}</span>}
        />
      ) : null}
      {statusError && connected && record && !unconfigured ? (
        <Banner status="info" title="Status is out of date" description={statusError} />
      ) : null}

      <SyncCard project={project} />

      <section className="flex flex-col gap-2">
        <Heading level={4} accessibilityLevel={2}>
          Sync history
        </Heading>
        <ActivityList events={history ?? []} />
      </section>
    </>
  );
}
