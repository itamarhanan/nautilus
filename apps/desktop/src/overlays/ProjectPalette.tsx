import { useMemo, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { Badge } from "@astryxdesign/core/Badge";
import { CommandPalette, CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import { Text } from "@astryxdesign/core/Text";
import { FolderOpen, FolderSearch, FolderGit2, History } from "lucide-react";
import { useApp } from "../context";
import { folderIo } from "../lib/files";
import {
  collapseHome,
  describeFolder,
  expandHome,
  fuzzyMatch,
  rankFolders,
  type FolderCandidate,
} from "../lib/folders";
import { AddProjectDialog } from "./AddProjectDialog";

type PaletteData = {
  group: string;
  kind: "project" | "folder" | "browse";
  path: string;
  projectId?: string;
  candidate?: FolderCandidate;
  recent?: boolean;
};

type PaletteItem = SearchableItem<PaletteData>;

const maxRecent = 8;

export function ProjectPalette() {
  const open = useApp((state) => state.paletteOpen);
  const setOpen = useApp((state) => state.setPaletteOpen);
  const projects = useApp((state) => state.appState.projects);
  const recent = useApp((state) => state.appState.recentFolders);
  const scanned = useApp((state) => state.appState.scan?.folders);
  const scanning = useApp((state) => state.scanning);
  const home = useApp((state) => state.home);
  const selectProject = useApp((state) => state.selectProject);
  const touchFolder = useApp((state) => state.touchFolder);
  const notify = useApp((state) => state.notify);
  const query = useRef("");
  const [pending, setPending] = useState<FolderCandidate | null>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const byPath = new Map((scanned ?? []).map((folder) => [folder.path, folder]));
    const added = new Set(projects.map((project) => project.localPath));
    const recentPaths = recent.map((entry) => entry.path).filter((path) => !added.has(path));
    const list: PaletteItem[] = projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      auxiliaryData: {
        group: "Your projects",
        kind: "project",
        path: project.localPath,
        projectId: project.id,
      },
    }));
    for (const path of recentPaths.slice(0, maxRecent)) {
      const candidate = byPath.get(path);
      list.push({
        id: `folder:${path}`,
        label: candidate?.name ?? path.split("/").at(-1) ?? path,
        auxiliaryData: { group: "Recent", kind: "folder", path, candidate, recent: true },
      });
    }
    const shown = new Set([...added, ...recentPaths.slice(0, maxRecent)]);
    for (const folder of scanned ?? []) {
      if (shown.has(folder.path)) continue;
      list.push({
        id: `folder:${folder.path}`,
        label: folder.name,
        auxiliaryData: {
          group: "On this PC",
          kind: "folder",
          path: folder.path,
          candidate: folder,
        },
      });
    }
    return list;
  }, [projects, recent, scanned]);

  const browse: PaletteItem = useMemo(
    () => ({
      id: "browse",
      label: "Browse…",
      auxiliaryData: {
        group: "Other",
        kind: "browse",
        path: "Choose any folder with the system dialog",
      },
    }),
    [],
  );

  const source = useMemo<SearchSource<PaletteItem>>(
    () => ({
      bootstrap: () => {
        query.current = "";
        return [...items, browse];
      },
      search: (value) => {
        query.current = value;
        const ranked = rankFolders(
          value,
          items.map((item) => ({ item, name: item.label, path: item.auxiliaryData?.path ?? "" })),
        ).map((entry) => entry.item.item);
        return [...ranked, browse];
      },
    }),
    [items, browse],
  );

  const chooseFolder = async (absolute: string) => {
    try {
      const entries = await folderIo.listDir(absolute);
      const candidate = (await describeFolder(absolute, entries, folderIo, home)) ?? {
        name: absolute.split("/").filter(Boolean).at(-1) ?? absolute,
        path: collapseHome(absolute, home),
        git: false,
        packageManager: null,
        devScript: null,
      };
      touchFolder(candidate.path);
      setPending(candidate);
    } catch {
      notify({
        tone: "error",
        title: "That folder cannot be read",
        body: "Nautilus can only add folders inside your home directory.",
      });
    }
  };

  const select = (id: string) => {
    const item = [...items, browse].find((entry) => entry.id === id);
    const data = item?.auxiliaryData;
    if (!data) return;
    if (data.kind === "project" && data.projectId) {
      selectProject(data.projectId);
    } else if (data.kind === "folder") {
      if (data.candidate) {
        touchFolder(data.candidate.path);
        setPending(data.candidate);
      } else {
        void chooseFolder(expandHome(data.path, home));
      }
    } else {
      openFolderDialog({ directory: true, defaultPath: home, title: "Choose a project folder" })
        .then((picked) => {
          if (typeof picked === "string") void chooseFolder(picked);
        })
        .catch(() => {
          notify({ tone: "error", title: "Could not open the folder picker" });
        });
    }
  };

  return (
    <>
      <CommandPalette<PaletteItem>
        isOpen={open}
        onOpenChange={setOpen}
        label="Projects and folders"
        searchSource={source}
        onValueChange={select}
        emptySearchText="No matching folders. Try Browse…"
        input={
          <CommandPaletteInput
            placeholder={scanning ? "Search folders (scanning…)" : "Search projects and folders"}
          />
        }
        renderItem={(item) => <PaletteRow item={item} query={query.current} />}
      />
      <AddProjectDialog
        folder={pending}
        onClose={() => {
          setPending(null);
        }}
      />
    </>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const match = query ? fuzzyMatch(query, text) : null;
  if (!match || match.indices.length === 0) return <>{text}</>;
  const marked = new Set(match.indices);
  return (
    <>
      {Array.from({ length: text.length }, (_, index) => text.charAt(index)).map(
        (character, index) =>
          marked.has(index) ? (
            <mark key={index} className="bg-transparent font-semibold text-accent">
              {character}
            </mark>
          ) : (
            <span key={index}>{character}</span>
          ),
      )}
    </>
  );
}

function PaletteRow({ item, query }: { item: PaletteItem; query: string }) {
  const data = item.auxiliaryData;
  const icon =
    data?.kind === "browse" ? (
      <FolderSearch className="size-4 shrink-0 text-secondary" aria-hidden />
    ) : data?.kind === "project" ? (
      <FolderOpen className="size-4 shrink-0 text-accent" aria-hidden />
    ) : data?.recent ? (
      <History className="size-4 shrink-0 text-secondary" aria-hidden />
    ) : (
      <FolderGit2 className="size-4 shrink-0 text-secondary" aria-hidden />
    );
  const candidate = data?.candidate;
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          <Highlighted text={item.label} query={query} />
        </span>
        <Text type="supporting" maxLines={1}>
          {data?.path}
        </Text>
      </div>
      <div className="flex shrink-0 gap-1">
        {data?.kind === "project" ? <Badge variant="info" label="Added" /> : null}
        {candidate?.git ? <Badge label="git" /> : null}
        {candidate?.packageManager ? <Badge label={candidate.packageManager} /> : null}
        {candidate?.devScript ? <Badge variant="success" label={candidate.devScript} /> : null}
      </div>
    </div>
  );
}
