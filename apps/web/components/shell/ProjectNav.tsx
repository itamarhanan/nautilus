import type { SessionRecord } from "@nautilus/types";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { FolderGit2, MessageSquare, MessageSquarePlus } from "lucide-react";
import { readableStatus } from "@nautilus/copy";
import { projectStatus } from "@/lib/project";
import { useActions, useWorkspace } from "@/store";

const NO_SESSIONS: SessionRecord[] = [];

function sessionStatusDot(status: SessionRecord["status"]) {
  if (status === "running") return <StatusDot variant="accent" label="Running" isPulsing />;
  if (status === "error" || status === "interrupted") {
    return <StatusDot variant="warning" label={readableStatus(status)} />;
  }
  return undefined;
}

export function ProjectNav() {
  const projects = useWorkspace((state) => state.projects);
  const selectedProjectId = useWorkspace((state) => state.project?.id ?? null);
  const sessions = useWorkspace((state) => state.project?.sessions ?? NO_SESSIONS);
  const sessionId = useWorkspace((state) => state.session?.id ?? null);
  const isCreating = useWorkspace((state) => state.pending.newSession);
  const isInfoOpen = useWorkspace((state) => state.isInfoOpen);
  const { selectProject, selectSession, createSession } = useActions();

  return (
    <SideNav
      resizable={{
        defaultWidth: 280,
        minWidth: 220,
        maxWidth: 420,
        autoSaveId: "nautilus-project-nav",
      }}
    >
      <SideNavSection title="Projects" subtitle={`${String(projects.length)} on this runner`}>
        {projects.length === 0 ? (
          <div className="px-3 py-2">
            <Text type="supporting">No projects yet. Add one from Nautilus on your PC.</Text>
          </div>
        ) : null}
        {projects.map((project) => {
          const isSelected = project.id === selectedProjectId;
          const status = projectStatus(project);
          return (
            <SideNavItem
              key={project.id}
              label={project.name}
              icon={FolderGit2}
              isSelected={isSelected && !isInfoOpen && sessionId === null}
              endContent={
                <StatusDot variant={status.tone} label={status.label} tooltip={status.label} />
              }
              onClick={() => {
                selectProject(project.id);
              }}
            >
              {isSelected ? (
                <>
                  {sessions.map((session) => (
                    <SideNavItem
                      key={session.id}
                      label={session.title}
                      icon={MessageSquare}
                      size="sm"
                      isSelected={session.id === sessionId && !isInfoOpen}
                      endContent={sessionStatusDot(session.status)}
                      onClick={() => {
                        selectSession(project.id, session.id);
                      }}
                    />
                  ))}
                  <SideNavItem
                    label={isCreating ? "Creating…" : "New session"}
                    icon={MessageSquarePlus}
                    size="sm"
                    isDisabled={isCreating}
                    onClick={() => void createSession()}
                  />
                </>
              ) : undefined}
            </SideNavItem>
          );
        })}
      </SideNavSection>
    </SideNav>
  );
}
