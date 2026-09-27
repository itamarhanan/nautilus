import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNavToggle } from "@astryxdesign/core/MobileNav";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { Info } from "lucide-react";
import { useActions, useWorkspace } from "@/store";
import { ConnectionBadge } from "./ConnectionBadge";

export function WorkspaceTopNav() {
  const { isMobile } = useAppShellMobile();
  const device = useWorkspace((state) => state.device);
  const isInfoOpen = useWorkspace((state) => state.isInfoOpen);
  const { setInfoOpen } = useActions();
  return (
    <TopNav
      label="Nautilus"
      className={isMobile ? "gap-2 px-4" : undefined}
      heading={
        <div className="flex items-center gap-1">
          <MobileNavToggle label="Show projects" />
          <TopNavHeading
            heading="Nautilus"
            subheading={isMobile ? undefined : (device?.name ?? "Runner session")}
          />
        </div>
      }
      endContent={
        <>
          <ConnectionBadge />
          <IconButton
            label="Connection and device info"
            tooltip="Info"
            variant={isInfoOpen ? "secondary" : "ghost"}
            icon={<Info className="size-4" aria-hidden />}
            onClick={() => {
              setInfoOpen(!isInfoOpen);
            }}
          />
        </>
      }
    />
  );
}
