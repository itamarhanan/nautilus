import { useEffect, useMemo, useRef } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Notifier } from "./components/Notifier";
import { TopBar } from "./components/TopBar";
import { StoreProvider, useApp } from "./context";
import { AgentProcess } from "./lib/agent";
import { ControlChannel } from "./lib/control";
import { openInEditor } from "./lib/editor";
import {
  desktopPaths,
  folderIo,
  loadSettings,
  loadState,
  saveSettings,
  saveState,
} from "./lib/files";
import { isEditableTarget, isMod } from "./lib/keys";
import { killTauriChild, tauriSpawner } from "./lib/process";
import type { StateProject } from "./lib/state";
import { onQuitRequested, systemAlert } from "./lib/window";
import { LinkPhoneDialog } from "./overlays/LinkPhoneDialog";
import { ProjectPalette } from "./overlays/ProjectPalette";
import { ReviewSheet } from "./overlays/ReviewSheet";
import { createDesktopStore } from "./store";
import type { Route } from "./store/types";
import { HomeView } from "./views/HomeView";
import { ProjectView } from "./views/ProjectView";
import { SettingsView } from "./views/SettingsView";

const localMode = import.meta.env.VITE_NAUTILUS_LOCAL_MODE === "1";
const statusIntervalMs = 30_000;
const agentPidKey = "nautilus.agentPid";

type ShortcutContext = {
  ready: boolean;
  bootError: string | null;
  paletteOpen: boolean;
  routeName: string;
  projectIds: string[];
};

type Shortcut =
  | { kind: "goUp" }
  | { kind: "palette"; open: boolean }
  | { kind: "settings" }
  | { kind: "selectProject"; id: string }
  | null;

const DIALOG_OPEN = "dialog[open]";

function isBlocked(context: ShortcutContext): boolean {
  return (
    !context.ready || context.bootError !== null || document.querySelector(DIALOG_OPEN) !== null
  );
}

function plainShortcut(event: KeyboardEvent, context: ShortcutContext): Shortcut {
  if (event.key.toLowerCase() !== "escape") return null;
  if (event.defaultPrevented || context.paletteOpen) return null;
  if (isBlocked(context) || isEditableTarget(event.target)) return null;
  return { kind: "goUp" };
}

function modShortcut(event: KeyboardEvent, context: ShortcutContext): Shortcut {
  const key = event.key.toLowerCase();
  const index = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
  if (key !== "k" && key !== "," && index < 0) return null;
  if (key === "k" && context.paletteOpen) return { kind: "palette", open: false };
  if (isBlocked(context)) return null;
  if (key === "k") return { kind: "palette", open: true };
  if (key === ",") return { kind: context.routeName === "settings" ? "goUp" : "settings" };
  const id = context.projectIds[index];
  return id ? { kind: "selectProject", id } : null;
}

export function shortcut(event: KeyboardEvent, context: ShortcutContext): Shortcut {
  if (event.altKey || event.shiftKey) return null;
  return isMod(event) ? modShortcut(event, context) : plainShortcut(event, context);
}

function applyShortcut(action: Exclude<Shortcut, null>, actions: ShortcutActions): void {
  switch (action.kind) {
    case "goUp":
      actions.goUp();
      return;
    case "palette":
      actions.setPaletteOpen(action.open);
      return;
    case "settings":
      actions.navigate({ name: "settings", section: "runner" });
      return;
    case "selectProject":
      actions.selectProject(action.id);
  }
}

type ShortcutActions = {
  setPaletteOpen: (open: boolean) => void;
  navigate: (route: { name: "settings"; section: "runner" }) => void;
  goUp: () => void;
  selectProject: (id: string) => void;
};

function useShortcuts(context: ShortcutContext, actions: ShortcutActions): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = shortcut(event, context);
      if (!action) return;
      event.preventDefault();
      applyShortcut(action, actions);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [context, actions]);
}

function useStatusPolling(
  connected: boolean,
  onHome: boolean,
  selectedId: string | null,
  refreshProjects: () => Promise<void>,
  refreshStatus: (projectId?: string) => Promise<void>,
  refreshHistory: () => Promise<void>,
  refreshDevices: () => Promise<void>,
): void {
  useEffect(() => {
    if (!connected) return;
    const refresh = () => {
      const everything = onHome || document.visibilityState !== "visible";
      void refreshProjects();
      void refreshStatus(everything ? undefined : (selectedId ?? undefined));
    };
    const onFocus = () => {
      void refreshProjects();
      void refreshStatus();
      void refreshDevices();
      if (onHome) void refreshHistory();
    };
    const timer = window.setInterval(refresh, statusIntervalMs);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [
    connected,
    onHome,
    selectedId,
    refreshProjects,
    refreshStatus,
    refreshHistory,
    refreshDevices,
  ]);
}

export default function App() {
  const store = useMemo(() => {
    let home = "";
    return createDesktopStore({
      paths: async () => {
        const paths = await desktopPaths();
        home = paths.home;
        return paths;
      },
      loadSettings,
      saveSettings,
      loadState,
      saveState,
      folderIo,
      spawn: tauriSpawner,
      localMode,
      openFile: openInEditor,
      alert: (title, body) => {
        void systemAlert(title, body).catch(() => undefined);
      },
      channel: new ControlChannel({
        spawn: tauriSpawner,
        get home() {
          return home;
        },
        localMode,
      }),
      agent: () =>
        Promise.resolve(
          new AgentProcess({
            spawn: tauriSpawner,
            devOrigins: import.meta.env.DEV ? [window.location.origin] : [],

            previous: {
              read: () => {
                const pid = Number(sessionStorage.getItem(agentPidKey));
                return Number.isInteger(pid) && pid > 0 ? pid : null;
              },
              write: (pid) => {
                if (pid === null) sessionStorage.removeItem(agentPidKey);
                else sessionStorage.setItem(agentPidKey, String(pid));
              },
              kill: killTauriChild,
            },
          }),
        ),
    });
  }, []);

  useEffect(() => onQuitRequested(() => store.getState().shutdown()), [store]);

  return (
    <StoreProvider store={store}>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const init = useApp((state) => state.init);
  const ready = useApp((state) => state.ready);
  const bootError = useApp((state) => state.bootError);
  const route = useApp((state) => state.route);
  const projects = useApp((state) => state.appState.projects);
  const selectedId = useApp((state) => state.selectedProjectId);
  const refreshProjects = useApp((state) => state.refreshProjects);
  const refreshStatus = useApp((state) => state.refreshStatus);
  const refreshHistory = useApp((state) => state.refreshHistory);
  const refreshDevices = useApp((state) => state.refreshDevices);
  const setPaletteOpen = useApp((state) => state.setPaletteOpen);
  const paletteOpen = useApp((state) => state.paletteOpen);
  const navigate = useApp((state) => state.navigate);
  const goUp = useApp((state) => state.goUp);
  const selectProject = useApp((state) => state.selectProject);
  const connected = useApp((state) => state.connection.phase === "connected");

  useEffect(() => {
    void init();
  }, [init]);

  const context = useMemo<ShortcutContext>(
    () => ({
      ready,
      bootError,
      paletteOpen,
      routeName: route.name,
      projectIds: projects.map((project) => project.id),
    }),
    [ready, bootError, paletteOpen, route.name, projects],
  );
  const actions = useMemo<ShortcutActions>(
    () => ({ setPaletteOpen, navigate, goUp, selectProject }),
    [setPaletteOpen, navigate, goUp, selectProject],
  );
  useShortcuts(context, actions);

  const onHome = route.name !== "project";
  useStatusPolling(
    connected,
    onHome,
    selectedId,
    refreshProjects,
    refreshStatus,
    refreshHistory,
    refreshDevices,
  );

  const selected = projects.find((project) => project.id === selectedId);

  const scroller = useRef<HTMLDivElement>(null);
  const place = route.name === "project" ? `project:${route.tab}` : route.name;
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [place, selected?.id]);

  return (
    <AppShell height="fill" contentPadding={0} mobileNav={false} topNav={<TopBar />}>
      <div ref={scroller} className="h-full overflow-y-auto">
        <RouteView
          ready={ready}
          bootError={bootError}
          route={route}
          selected={selected}
          onRetry={() => {
            window.location.reload();
          }}
        />
      </div>
      <ProjectPalette />
      <LinkPhoneDialog />
      <ReviewSheet />
      <Notifier />
    </AppShell>
  );
}

function RouteView({
  ready,
  bootError,
  route,
  selected,
  onRetry,
}: {
  ready: boolean;
  bootError: string | null;
  route: Route;
  selected: StateProject | undefined;
  onRetry: () => void;
}) {
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" label="Starting Nautilus" />
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <Banner
          status="error"
          title="Nautilus could not start"
          description={<span className="select-text">{bootError}</span>}
          endContent={<Button label="Try again" size="sm" variant="secondary" onClick={onRetry} />}
        />
      </div>
    );
  }
  if (route.name === "settings") return <SettingsView section={route.section} />;
  if (route.name === "project" && selected) {
    return <ProjectView project={selected} tab={route.tab} />;
  }
  return <HomeView />;
}
