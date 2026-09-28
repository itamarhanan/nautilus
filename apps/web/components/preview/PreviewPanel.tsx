import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProjectRecord } from "@nautilus/types";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { ExternalLink, MonitorOff, Play, RefreshCw } from "lucide-react";
import { useOpenPreview } from "@/hooks/useOpenPreview";
import { errorMessage } from "@/lib/api/client";
import { projectNotReadyReason, projectStatus } from "@/lib/project";
import { useActions, useWorkspace } from "@/store";
import { CenteredEmptyState } from "../common/CenteredEmptyState";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed"; error: string };

// A preview link opened on its own shows a page that posts the one-time token
// back, so a link-preview fetch cannot use it up. Some mobile browsers leave
// that page waiting for a tap inside a frame, so this page posts the token
// into the frame itself.
function EmbeddedPreview({ url, title }: { url: string; title: string }) {
  const form = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  const name = useId();

  useEffect(() => {
    // The token redeems once, so a second run of this effect must not post it.
    if (submitted.current) return;
    submitted.current = true;
    form.current?.submit();
  }, []);

  return (
    <>
      <form ref={form} method="post" action={url} target={name} hidden />
      <iframe
        name={name}
        className="size-full border-0 bg-white"
        title={title}
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
      />
    </>
  );
}

export function PreviewPanel({ project }: { project: ProjectRecord }) {
  const { previewUrl, changeProjectState } = useActions();
  const control = useWorkspace((state) => state.pending.projectControl);
  const openPreview = useOpenPreview();
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });

  const latestRequest = useRef(0);
  const status = projectStatus(project);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setPreview({ status: "loading" });
    try {
      const url = await previewUrl();
      if (request === latestRequest.current) setPreview({ status: "ready", url });
    } catch (error) {
      if (request === latestRequest.current) {
        setPreview({
          status: "failed",
          error: errorMessage(error, "Unable to load preview"),
        });
      }
    }
  }, [previewUrl]);

  useEffect(() => {
    if (status.isServing) void load();
  }, [load, status.isServing]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        label="Preview actions"
        size="sm"
        className="px-4"
        dividers={["bottom"]}
        startContent={
          <Text type="supporting" maxLines={1}>
            {project.previewPath}
          </Text>
        }
        endContent={
          <>
            <IconButton
              label="Reload preview"
              tooltip="Reload"
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="size-4" aria-hidden />}
              clickAction={load}
              isDisabled={!status.isServing}
            />
            <Button
              label="Open"
              size="sm"
              variant="ghost"
              icon={<ExternalLink className="size-3.5" aria-hidden />}
              clickAction={openPreview}
              isDisabled={!status.isServing}
            />
          </>
        }
      />
      <div className="relative min-h-0 flex-1 bg-surface">
        {!status.isServing ? (
          status.isStarting ? (
            <div className="flex h-full items-center justify-center p-6">
              <Spinner size="lg" label="Starting the dev server" />
            </div>
          ) : status.needsRecovery ? (
            <CenteredEmptyState
              icon={MonitorOff}
              title="The project needs recovery"
              description="The runner will not start it until it is recovered from Nautilus on your PC."
            />
          ) : !status.isReady ? (
            <CenteredEmptyState
              icon={MonitorOff}
              title="Nothing to preview yet"
              description={projectNotReadyReason(project)}
            />
          ) : (
            <CenteredEmptyState
              icon={MonitorOff}
              title="The project is not running"
              description="Start its dev server to see the preview here."
              actions={
                <Button
                  label="Start project"
                  variant="primary"
                  icon={<Play className="size-3.5" aria-hidden />}
                  isLoading={control === "start"}
                  isDisabled={control !== null}
                  clickAction={() => changeProjectState("start")}
                />
              }
            />
          )
        ) : preview.status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner size="lg" label="Requesting a preview token" />
          </div>
        ) : preview.status === "failed" ? (
          <CenteredEmptyState
            icon={MonitorOff}
            title="Preview unavailable"
            description={preview.error}
            actions={<Button label="Try again" clickAction={load} />}
          />
        ) : (
          <EmbeddedPreview key={preview.url} url={preview.url} title={`${project.name} preview`} />
        )}
      </div>
    </div>
  );
}
