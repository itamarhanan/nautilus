import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import type {
  ConflictChange,
  ConflictResolution,
  SyncConflict,
  SyncFileChange,
  SyncResolutions,
} from "@nautilus/types";
import { Columns2, SquarePen } from "lucide-react";
import { messageOf } from "../lib/errors";
import { SingleFileDiff } from "./DiffView";

const DONE: Record<ConflictChange, string> = {
  added: "added",
  modified: "edited",
  deleted: "deleted",
};

function describeConflict(conflict: SyncConflict): string {
  const { pc, runner } = conflict;
  if (!pc || !runner) return "Changed on both sides";
  if (pc === runner) {
    return pc === "added" ? "Added on both sides with different content" : "Edited on both sides";
  }
  const text = `${DONE[pc]} on the PC, ${DONE[runner]} on the runner`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function optionLabel(side: "PC" | "Runner", change: ConflictChange | undefined): string {
  return change === "deleted" ? `${side} (delete)` : `${side} version`;
}

export function ConflictList({
  conflicts,
  resolutions,
  onResolve,
  onCompare,
  onOpen,
  isDisabled = false,
}: {
  conflicts: SyncConflict[];
  resolutions: SyncResolutions;
  onResolve: (paths: string[], side: ConflictResolution | null) => void;

  onCompare?: (path: string) => Promise<SyncFileChange>;

  onOpen: (path: string) => void;
  isDisabled?: boolean;
}) {
  const paths = conflicts.map((conflict) => conflict.path);
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Text type="supporting" className="grow">
          Keep one side's version of each file.
        </Text>
        <Button
          label="All from PC"
          size="sm"
          variant="secondary"
          isDisabled={isDisabled}
          onClick={() => {
            onResolve(paths, "pc");
          }}
        />
        <Button
          label="All from runner"
          size="sm"
          variant="secondary"
          isDisabled={isDisabled}
          onClick={() => {
            onResolve(paths, "runner");
          }}
        />
      </HStack>
      <VStack gap={2}>
        {conflicts.map((conflict) => (
          <ConflictRow
            key={conflict.path}
            conflict={conflict}
            side={resolutions[conflict.path]}
            onResolve={onResolve}
            onCompare={onCompare}
            onOpen={onOpen}
            isDisabled={isDisabled}
          />
        ))}
      </VStack>
    </VStack>
  );
}

type Comparison =
  | { status: "closed" }
  | { status: "loading" }
  | { status: "ready"; file: SyncFileChange }
  | { status: "error"; message: string };

function ConflictRow({
  conflict,
  side,
  onResolve,
  onCompare,
  onOpen,
  isDisabled,
}: {
  conflict: SyncConflict;
  side: ConflictResolution | undefined;
  onResolve: (paths: string[], side: ConflictResolution | null) => void;
  onCompare?: (path: string) => Promise<SyncFileChange>;
  onOpen: (path: string) => void;
  isDisabled: boolean;
}) {
  const [comparison, setComparison] = useState<Comparison>({
    status: "closed",
  });
  const toggleCompare = () => {
    if (!onCompare) return;
    if (comparison.status !== "closed") {
      setComparison({ status: "closed" });
      return;
    }
    setComparison({ status: "loading" });
    onCompare(conflict.path).then(
      (file) => {
        setComparison({ status: "ready", file });
      },
      (error: unknown) => {
        setComparison({
          status: "error",
          message: messageOf(error, "Could not compare the file"),
        });
      },
    );
  };
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-3 px-3 py-2">
        <VStack gap={0} className="min-w-0 grow">
          <Text type="code" size="xsm" className="truncate select-text">
            {conflict.path}
          </Text>
          <Text type="supporting" size="xsm">
            {describeConflict(conflict)}
          </Text>
        </VStack>
        {onCompare ? (
          <Button
            label="Compare"
            size="sm"
            variant={comparison.status === "closed" ? "ghost" : "secondary"}
            isIconOnly
            icon={<Columns2 className="size-4" aria-hidden />}
            tooltip="Compare this PC's version with the runner's"
            onClick={toggleCompare}
          />
        ) : null}
        {conflict.pc === "deleted" ? null : (
          <Button
            label="Open in editor"
            size="sm"
            variant="ghost"
            isIconOnly
            icon={<SquarePen className="size-4" aria-hidden />}
            tooltip="Open this PC's copy in its default app"
            onClick={() => {
              onOpen(conflict.path);
            }}
          />
        )}
        <SegmentedControl
          label={`Version of ${conflict.path} to keep`}
          size="sm"
          value={side ?? ""}
          isDisabled={isDisabled}
          onChange={(value) => {
            onResolve([conflict.path], value === "pc" || value === "runner" ? value : null);
          }}
        >
          <SegmentedControlItem value="pc" label={optionLabel("PC", conflict.pc)} />
          <SegmentedControlItem value="runner" label={optionLabel("Runner", conflict.runner)} />
        </SegmentedControl>
      </div>
      {comparison.status === "closed" ? null : (
        <div className="border-t border-border">
          {comparison.status === "loading" ? (
            <div className="flex justify-center py-3">
              <Spinner size="sm" />
            </div>
          ) : comparison.status === "error" ? (
            <div className="px-3 py-2">
              <Text type="supporting" className="text-error">
                {comparison.message}
              </Text>
            </div>
          ) : (
            <>
              <div className="px-3 py-1.5">
                <Text type="supporting" size="xsm">
                  <span className="text-error">−</span> this PC ·{" "}
                  <span className="text-success">+</span> runner
                </Text>
              </div>
              <SingleFileDiff file={comparison.file} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
