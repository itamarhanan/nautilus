import { useEffect } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { CheckCircle2 } from "lucide-react";
import { review as reviewText } from "@nautilus/copy";
import type { ConflictResolution, SyncFileChange, SyncDiff } from "@nautilus/types";
import { ConflictList } from "../components/ConflictList";
import { DiffView } from "../components/DiffView";
import { useApp } from "../context";
import { directionWords, plural } from "../lib/format";
import { isModEnter } from "../lib/keys";
import { conflictsOf } from "../store";
import type { Review } from "../store/types";

const STEP_LABEL = reviewText.step;

const CLOSED_PHASES = new Set(["done", "blocked", "failed"]);

type ReviewView = {
  review: Review;
  open: boolean;
  words: ReturnType<typeof directionWords>;
  diff: SyncDiff | null;
  conflicts: ReturnType<typeof conflictsOf>;
  fileCount: number;
  resolving: boolean;
  allResolved: boolean;
  unresolved: number;
  canApply: boolean;
  firstSync: boolean;
};

function reviewView(review: Review | null): ReviewView | null {
  if (!review) return null;
  const diff = review.preview?.diff ?? review.result?.diff ?? null;
  const resultConflicts = conflictsOf(review.result);
  const conflicts = resultConflicts.length > 0 ? resultConflicts : conflictsOf(review.preview);
  const fileCount = diff?.files.length ?? 0;
  const resolving = review.phase === "resolving";
  const allResolved =
    conflicts.length > 0 && conflicts.every((conflict) => conflict.path in review.resolutions);
  const open = !review.background;
  return {
    review,
    open,
    words: directionWords(review.direction),
    diff,
    conflicts,
    fileCount,
    resolving,
    allResolved,
    unresolved: conflicts.filter((conflict) => !(conflict.path in review.resolutions)).length,
    canApply: open && ((review.phase === "ready" && fileCount > 0) || (resolving && allResolved)),
    firstSync: review.preview?.status === "ok" && review.preview.state?.baseHead === null,
  };
}

function applyLabel(view: ReviewView): string {
  if (view.resolving) {
    return view.allResolved
      ? reviewText.withTheseChoices(view.words.verb)
      : reviewText.chooseFiles(view.unresolved);
  }
  if (view.fileCount === 0) return reviewText.nothingToApply;
  return `${view.words.verb} ${plural(view.fileCount, "file")}`;
}

function useApplyShortcut(canApply: boolean, apply: () => void): void {
  useEffect(() => {
    if (!canApply) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isModEnter(event)) return;
      event.preventDefault();
      apply();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [canApply, apply]);
}

export function ReviewSheet() {
  const review = useApp((state) => state.review);
  const projectName = useApp(
    (state) =>
      state.appState.projects.find((project) => project.id === state.review?.projectId)?.name,
  );
  const applyReview = useApp((state) => state.applyReview);
  const resolveConflicts = useApp((state) => state.resolveConflicts);
  const compareConflict = useApp((state) => state.compareConflict);
  const openConflictFile = useApp((state) => state.openConflictFile);
  const closeReview = useApp((state) => state.closeReview);
  const startReview = useApp((state) => state.startReview);

  const view = reviewView(review);
  useApplyShortcut(view?.canApply ?? false, () => {
    void applyReview();
  });

  const onClose = () => void closeReview();
  const onApply = () => void applyReview();
  const onRetry = () => {
    if (!view) return;
    void startReview(view.review.direction, view.review.projectId);
  };

  return (
    <Dialog
      isOpen={view?.open ?? false}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      width={880}
      maxHeight="85dvh"
    >
      <Layout
        header={
          <DialogHeader
            title={`${view?.words.verb ?? ""} ${projectName ?? ""}`.trim()}
            subtitle={view ? reviewText.subtitle[view.review.direction] : undefined}
            onOpenChange={onClose}
          />
        }
        content={
          <LayoutContent>
            {view ? (
              <ReviewBody
                view={view}
                onRetry={onRetry}
                conflicts={{
                  onResolve: resolveConflicts,
                  onCompare: compareConflict,
                  onOpen: (path) => void openConflictFile(path),
                }}
              />
            ) : null}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end" vAlign="center">
              {view ? <ReviewFooter view={view} onClose={onClose} onApply={onApply} /> : null}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

type ConflictHandlers = {
  onResolve: (paths: string[], side: ConflictResolution | null) => void;
  onCompare?: (path: string) => Promise<SyncFileChange>;
  onOpen: (path: string) => void;
};

function ReviewBody({
  view,
  onRetry,
  conflicts,
}: {
  view: ReviewView;
  onRetry: () => void;
  conflicts: ConflictHandlers;
}) {
  const { review } = view;
  if (review.phase === "preparing") {
    return (
      <VStack gap={3}>
        <ProgressBar label={STEP_LABEL[review.step ?? "authorizing"]} isIndeterminate />
        <Text type="supporting">{reviewText.preparingNote}</Text>
      </VStack>
    );
  }
  if (review.phase === "failed") {
    return (
      <RetryBanner
        status="error"
        title={reviewText.failed(view.words.verb)}
        error={review.error}
        onRetry={onRetry}
      />
    );
  }
  return (
    <VStack gap={4}>
      {view.resolving ? (
        <ResolvingBody
          view={view}
          onResolve={conflicts.onResolve}
          onCompare={review.direction === "pull" ? conflicts.onCompare : undefined}
          onOpen={conflicts.onOpen}
        />
      ) : null}
      {review.phase === "blocked" ? (
        <RetryBanner
          status="warning"
          title={
            view.conflicts.length > 0
              ? reviewText.conflictsTitle(view.conflicts.length)
              : reviewText.blocked(view.words.verb)
          }
          error={
            view.conflicts.length > 0
              ? reviewText.blockedConflictDescription
              : (review.error ?? reviewText.blockedStaleDescription)
          }
          onRetry={onRetry}
        />
      ) : null}
      {review.phase === "done" ? (
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-success" aria-hidden />
          <Text weight="semibold">
            {reviewText.done(view.words.done, view.fileCount, view.words.side)}
          </Text>
        </div>
      ) : null}
      {review.phase === "applying" ? (
        <ProgressBar label={STEP_LABEL.applying} isIndeterminate />
      ) : null}
      {review.phase === "ready" ? <ReadyBody view={view} /> : null}
      {review.phase === "ready" && review.environmentChanges.length > 0 ? (
        <Text type="supporting">
          {plural(review.environmentChanges.length, "preview variable")} also{" "}
          {review.environmentChanges.length === 1 ? "goes" : "go"} to the runner:{" "}
          <span className="select-text font-mono">{review.environmentChanges.join(", ")}</span>
        </Text>
      ) : null}
      {!view.resolving && view.conflicts.length > 0 && !view.diff ? (
        <VStack gap={1}>
          {view.conflicts.map((conflict) => (
            <Text key={conflict.path} type="code" size="xsm" className="select-text">
              {conflict.path}
            </Text>
          ))}
        </VStack>
      ) : null}
      {view.diff ? (
        <DiffView diff={view.diff} highlight={view.conflicts.map((conflict) => conflict.path)} />
      ) : null}
    </VStack>
  );
}

function ReadyBody({ view }: { view: ReviewView }) {
  if (view.fileCount === 0) {
    return <Text color="secondary">{reviewText.alreadyMatch}</Text>;
  }
  if (view.firstSync) {
    return (
      <Banner
        status="info"
        title={reviewText.firstSync[view.review.direction](view.fileCount)}
        description={reviewText.firstSyncNote}
      />
    );
  }
  const summary = view.diff
    ? ` (+${String(view.diff.additions)} −${String(view.diff.deletions)})`
    : "";
  return (
    <Text color="secondary">{reviewText.willChange(view.fileCount, view.words.side, summary)}</Text>
  );
}

function ResolvingBody({
  view,
  onResolve,
  onCompare,
  onOpen,
}: {
  view: ReviewView;
  onResolve: (paths: string[], side: ConflictResolution | null) => void;
  onCompare?: (path: string) => Promise<SyncFileChange>;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      <Banner
        status="warning"
        title={reviewText.conflictsTitle(view.conflicts.length)}
        description={reviewText.resolvingDescription}
      />
      <ConflictList
        conflicts={view.conflicts}
        resolutions={view.review.resolutions}
        onResolve={onResolve}
        onCompare={onCompare}
        onOpen={onOpen}
      />
    </>
  );
}

function RetryBanner({
  status,
  title,
  error,
  onRetry,
}: {
  status: "error" | "warning";
  title: string;
  error: string | null | undefined;
  onRetry: () => void;
}) {
  return (
    <Banner
      status={status}
      title={title}
      description={<span className="select-text">{error ?? reviewText.unknownError}</span>}
      endContent={
        <Button
          label={status === "error" ? reviewText.tryAgain : reviewText.reviewAgain}
          size="sm"
          variant="secondary"
          onClick={onRetry}
        />
      }
    />
  );
}

function ReviewFooter({
  view,
  onClose,
  onApply,
}: {
  view: ReviewView;
  onClose: () => void;
  onApply: () => void;
}) {
  const applying = view.review.phase === "applying";
  return (
    <>
      {view.canApply ? <Kbd keys="mod+enter" /> : null}
      {CLOSED_PHASES.has(view.review.phase) ? (
        <Button label={reviewText.close} variant="primary" onClick={onClose} />
      ) : (
        <>
          <Button
            label={applying ? reviewText.continueInBackground : reviewText.cancel}
            variant="secondary"
            onClick={onClose}
          />
          <Button
            label={applyLabel(view)}
            variant="primary"
            isLoading={applying}
            isDisabled={!view.canApply}
            onClick={onApply}
          />
        </>
      )}
    </>
  );
}
