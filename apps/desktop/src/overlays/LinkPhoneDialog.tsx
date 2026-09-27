import { useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { CheckCircle2 } from "lucide-react";
import { QrCode } from "../components/QrCode";
import { useApp } from "../context";

function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
}

export function LinkPhoneDialog() {
  const open = useApp((state) => state.linkPhoneOpen);
  const setOpen = useApp((state) => state.setLinkPhoneOpen);
  const pairing = useApp((state) => state.pairing);
  const pairingError = useApp((state) => state.pairingError);
  const devices = useApp((state) => state.devices);
  const newPairingCode = useApp((state) => state.newPairingCode);
  const refreshDevices = useApp((state) => state.refreshDevices);
  const [now, setNow] = useState(Date.now());
  const knownDevices = useRef<Set<string> | null>(null);
  const [linkedName, setLinkedName] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      knownDevices.current = null;
      setLinkedName(null);
      return;
    }
    knownDevices.current ??= new Set(devices.map((device) => device.id));
  }, [open, devices]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
  }, [open]);

  useEffect(() => {
    if (!open || linkedName) return;
    const tick = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    const poll = window.setInterval(() => void refreshDevices(), 2_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [open, linkedName, refreshDevices]);

  useEffect(() => {
    if (!open || !knownDevices.current) return;
    const fresh = devices.find(
      (device) => !device.revokedAt && !knownDevices.current?.has(device.id),
    );
    if (fresh) setLinkedName(fresh.name);
  }, [open, devices]);

  useEffect(() => {
    if (!linkedName) return;
    const timer = window.setTimeout(() => {
      setOpen(false);
    }, 1_800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [linkedName, setOpen]);

  const remaining = pairing ? secondsLeft(pairing.expiresAt, now) : 0;
  useEffect(() => {
    if (open && pairing && remaining === 0 && !linkedName) void newPairingCode();
  }, [open, pairing, remaining, linkedName, newPairingCode]);

  return (
    <Dialog isOpen={open} onOpenChange={setOpen} width={420}>
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="Link a phone"
            subtitle="Scan with the phone's camera, then confirm on the phone."
            onOpenChange={setOpen}
          />
        }
        content={
          <LayoutContent>
            <div className="flex flex-col items-center gap-4 py-2">
              {linkedName ? (
                <div className="flex flex-col items-center gap-2 py-8">
                  <CheckCircle2 className="size-12 text-success" aria-hidden />
                  <Text weight="semibold">Linked: {linkedName}</Text>
                </div>
              ) : pairingError ? (
                <Banner
                  status="error"
                  title="Could not create a code"
                  description={pairingError}
                  endContent={
                    <Button
                      label="Retry"
                      size="sm"
                      variant="secondary"
                      onClick={() => void newPairingCode()}
                    />
                  }
                />
              ) : pairing ? (
                <>
                  <QrCode value={pairing.url} label="QR code that opens the phone link" />
                  <div className="flex flex-col items-center gap-1">
                    <Text type="supporting">Or enter this code on the phone</Text>
                    <span className="select-text font-mono text-2xl font-semibold tracking-widest">
                      {pairing.code}
                    </span>
                    <Text type="supporting" hasTabularNumbers>
                      {remaining === 0
                        ? "Renewing the code…"
                        : `Expires in ${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, "0")} · single use`}
                    </Text>
                  </div>
                </>
              ) : (
                <div className="py-16">
                  <Spinner size="lg" label="Creating a code" />
                </div>
              )}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
