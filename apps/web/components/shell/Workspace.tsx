import { AppShell } from "@astryxdesign/core/AppShell";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNavRenderContext } from "@astryxdesign/core/SideNav";
import { useLocationSync } from "@/hooks/useLocationSync";
import { useSessionStream } from "@/hooks/useSessionStream";
import { useSelectedProject, useWorkspace } from "@/store";
import { InfoPanel } from "../info/InfoPanel";
import { ProjectPanel } from "../project/ProjectPanel";
import { NoProjectOpen } from "./NoProjectOpen";
import { ProjectNav } from "./ProjectNav";
import { SignOutConfirm } from "./SignOutConfirm";
import { WorkspaceTopNav } from "./WorkspaceTopNav";

export function Workspace() {
  useSessionStream();
  useLocationSync();
  const isInfoOpen = useWorkspace((state) => state.isInfoOpen);
  const hasProjects = useWorkspace((state) => state.projects.length > 0);
  const project = useSelectedProject();

  return (
    <AppShell
      height="fill"
      className="h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))]"
      contentPadding={0}
      mobileNav={{
        hasToggle: false,

        content: (
          <MobileNav side="start" header="Projects">
            <SideNavRenderContext value="drawer-content">
              <ProjectNav />
            </SideNavRenderContext>
          </MobileNav>
        ),
      }}
      topNav={<WorkspaceTopNav />}
      sideNav={<ProjectNav />}
    >
      {isInfoOpen ? (
        <InfoPanel />
      ) : project ? (
        <ProjectPanel key={project.id} project={project} />
      ) : (
        <NoProjectOpen hasProjects={hasProjects} />
      )}
      <SignOutConfirm />
    </AppShell>
  );
}
