import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Heading, Text } from "@astryxdesign/core/Text";
import { CheckCircle2, FolderPlus, Plug, Smartphone } from "lucide-react";
import { useApp } from "../context";
import { activeDevices } from "../lib/format";

export function GetStarted() {
  const connection = useApp((state) => state.connection);
  const devices = useApp((state) => state.devices);
  const navigate = useApp((state) => state.navigate);
  const setLinkPhoneOpen = useApp((state) => state.setLinkPhoneOpen);
  const setPaletteOpen = useApp((state) => state.setPaletteOpen);
  const connected = connection.phase === "connected";
  const linked = activeDevices(devices).length > 0;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-10">
      <div className="flex flex-col gap-1">
        <Heading level={2} accessibilityLevel={1}>
          Get started
        </Heading>
        <Text color="secondary">Three steps, in any order once the runner is connected.</Text>
      </div>
      <Card padding={2}>
        <div className="flex flex-col divide-y divide-border">
          <Step
            icon={<Plug className="size-5" aria-hidden />}
            title="Connect to the runner"
            description={
              connected
                ? "Connected over SSH."
                : connection.phase === "connecting" || connection.phase === "reconnecting"
                  ? "Connecting…"
                  : (connection.error ?? "Enter the runner URL and the Studio's SSH user.")
            }
            done={connected}
            action={
              connected ? null : (
                <Button
                  label="Open settings"
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    navigate({ name: "settings", section: "runner" });
                  }}
                />
              )
            }
          />
          <Step
            icon={<Smartphone className="size-5" aria-hidden />}
            title="Link your phone"
            description={
              linked
                ? "A phone is linked. You can link more at any time."
                : "Scan a QR code with the phone's camera."
            }
            done={linked}
            action={
              <Button
                label={linked ? "Link another" : "Show QR code"}
                size="sm"
                variant={linked ? "secondary" : "primary"}
                isDisabled={!connected}
                onClick={() => {
                  setLinkPhoneOpen(true);
                }}
              />
            }
          />
          <Step
            icon={<FolderPlus className="size-5" aria-hidden />}
            title="Add a project"
            description="Pick a folder from this PC. Recent and detected projects are listed first."
            done={false}
            action={
              <div className="flex items-center gap-2">
                <Kbd keys="mod+k" />
                <Button
                  label="Choose folder"
                  size="sm"
                  variant="primary"
                  isDisabled={!connected}
                  onClick={() => {
                    setPaletteOpen(true);
                  }}
                />
              </div>
            }
          />
        </div>
      </Card>
    </div>
  );
}

function Step({
  icon,
  title,
  description,
  done,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  done: boolean;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-3 py-4">
      <span className={done ? "text-success" : "text-secondary"}>
        {done ? <CheckCircle2 className="size-5" aria-label="Done" /> : icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <Text weight="semibold">{title}</Text>
        <Text type="supporting">{description}</Text>
      </div>
      {action}
    </div>
  );
}
