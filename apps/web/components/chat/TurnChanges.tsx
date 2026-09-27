import { useState } from "react";
import type { SyncDiff, SyncFileChange } from "@nautilus/types";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { ChevronDown, ChevronRight, FileDiff, Undo2 } from "lucide-react";
import { errorMessage } from "@/lib/api/client";
import * as api from "@/lib/api/endpoints";
import type { TranscriptItem } from "@/lib/transcript";
import { useActions, useOpenSessionRecord, useWorkspace } from "@/store";

type CheckpointItem = Extract<TranscriptItem, { kind: "checkpoint" }>;

type Loaded =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; diff: SyncDiff }
  | { status: "error"; message: string };

export function TurnChanges({ item }: { item: CheckpointItem }) {
  const session = useOpenSessionRecord();
  const reverting = useWorkspace((state) => state.pending.revert);
  const { revertCheckpoint } = useActions();
  const [isOpen, setOpen] = useState(false);
  const [isConfirming, setConfirming] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ status: "idle" });

  if (item.previousHead === item.commit) {
    return (
      <div className="flex justify-center py-1">
        <Text type="supporting">No files changed</Text>
      </div>
    );
  }

  const toggle = () => {
    setOpen(!isOpen);
    if (isOpen || loaded.status === "loading" || loaded.status === "ready" || !session) return;
    setLoaded({ status: "loading" });
    api
      .getCheckpointChanges(session.id, item.commit)
      .then((diff) => {
        setLoaded({ status: "ready", diff });
      })
      .catch((error: unknown) => {
        setLoaded({ status: "error", message: errorMessage(error, "Unable to load the changes") });
      });
  };

  const summary =
    loaded.status === "ready"
      ? `${String(loaded.diff.files.length)} ${loaded.diff.files.length === 1 ? "file" : "files"} changed`
      : item.revertOf
        ? "Undid an earlier turn"
        : "Files changed in this turn";
  const isBusy = session?.status === "running";

  return (
    <div className="flex flex-col rounded-lg border border-border">
      <div className="flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left"
          aria-expanded={isOpen}
          onClick={toggle}
        >
          {isOpen ? (
            <ChevronDown className="size-4 shrink-0 text-secondary" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-secondary" aria-hidden />
          )}
          <FileDiff className="size-4 shrink-0 text-secondary" aria-hidden />
          <Text type="supporting" maxLines={1}>
            {summary}
          </Text>
          {loaded.status === "ready" ? <DiffCounts diff={loaded.diff} /> : null}
        </button>
        <Button
          label={item.revertOf ? "Redo" : "Undo"}
          size="sm"
          variant="ghost"
          icon={<Undo2 className="size-4" aria-hidden />}
          tooltip={isBusy ? "Wait for the agent to finish" : "Undo these changes on the runner"}
          isDisabled={isBusy || reverting !== null}
          isLoading={reverting === item.commit}
          onClick={() => {
            setConfirming(true);
          }}
        />
      </div>
      {isOpen ? <ChangesBody loaded={loaded} /> : null}
      <AlertDialog
        isOpen={isConfirming}
        onOpenChange={setConfirming}
        title={item.revertOf ? "Bring these changes back?" : "Undo this turn's changes?"}
        description="Only this turn's edits are reversed; anything changed after it is kept. The undo is saved like any other change, so it can be reversed too."
        actionLabel={item.revertOf ? "Bring back" : "Undo changes"}
        onAction={() => void revertCheckpoint(item.commit)}
      />
    </div>
  );
}

function DiffCounts({ diff }: { diff: Pick<SyncDiff, "additions" | "deletions"> }) {
  return (
    <span className="ml-auto shrink-0 font-mono text-xs">
      <span className="text-success">+{diff.additions}</span>{" "}
      <span className="text-error">-{diff.deletions}</span>
    </span>
  );
}

function ChangesBody({ loaded }: { loaded: Loaded }) {
  switch (loaded.status) {
    case "idle":
    case "loading":
      return (
        <div className="flex justify-center border-t border-border py-3">
          <Spinner size="sm" />
        </div>
      );
    case "error":
      return (
        <div className="border-t border-border px-3 py-2">
          <Text type="supporting" className="text-error">
            {loaded.message}
          </Text>
        </div>
      );
    case "ready":
      return (
        <ul className="flex flex-col border-t border-border">
          {loaded.diff.files.map((file) => (
            <FileChanges key={file.path} file={file} />
          ))}
        </ul>
      );
  }
}

const OMITTED: Record<NonNullable<SyncFileChange["omitted"]>, string> = {
  generated: "Generated file, not shown",
  large: "Too large to show here",
  limit: "Too large to show here",
};

function FileChanges({ file }: { file: SyncFileChange }) {
  const [isOpen, setOpen] = useState(false);
  const note = file.binary ? "Binary file" : file.omitted ? OMITTED[file.omitted] : null;
  const canOpen = note === null && file.hunks.length > 0;
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
        disabled={!canOpen}
        aria-expanded={canOpen ? isOpen : undefined}
        onClick={() => {
          setOpen(!isOpen);
        }}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {note ? <Text type="supporting">{note}</Text> : <DiffCounts diff={file} />}
      </button>
      {isOpen && canOpen ? (
        <div className="overflow-x-auto border-t border-border py-1 font-mono text-xs">
          {file.hunks.flatMap((hunk, hunkIndex) =>
            hunk.lines.map((line, lineIndex) => (
              <pre
                key={`${String(hunkIndex)}-${String(lineIndex)}`}
                className={`m-0 min-w-max whitespace-pre px-3 ${
                  line.type === "addition"
                    ? "bg-success-muted"
                    : line.type === "deletion"
                      ? "bg-error-muted"
                      : ""
                }`}
              >
                <span className="inline-block w-4 select-none text-secondary">
                  {line.type === "addition" ? "+" : line.type === "deletion" ? "-" : " "}
                </span>
                {line.content}
              </pre>
            )),
          )}
        </div>
      ) : null}
    </li>
  );
}
