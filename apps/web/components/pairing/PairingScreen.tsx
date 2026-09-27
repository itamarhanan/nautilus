import { useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { KeyRound, ShieldCheck } from "lucide-react";
import { errorMessage } from "@/lib/api/client";
import { guessDeviceName } from "@/lib/browser";
import { useActions, useWorkspace } from "@/store";
import { BrandMark } from "../common/BrandMark";

export function PairingScreen() {
  const { pair } = useActions();
  const isPairing = useWorkspace((state) => state.pending.pair);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("Phone");
  const [failure, setFailure] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = codeRef.current;
    if (!input) return;
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.enterKeyHint = "go";
    input.setAttribute("autocorrect", "off");
  }, []);

  useEffect(() => {
    setDeviceName((current) => (current === "Phone" ? guessDeviceName() : current));

    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get("pair");

    if (!fromLink) {
      codeRef.current?.focus();
      return;
    }
    const linked = fromLink.slice(0, 32);
    setCode(linked);
    url.searchParams.delete("pair");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // Scanning the link already did what typing the code would, so link at
    // once. A code that has expired or was used leaves the form filled in, with
    // the reason. The code is out of the address by now, so a second run of
    // this effect finds nothing to redeem.
    void (async () => {
      try {
        await pair(linked, guessDeviceName());
      } catch (error) {
        setFailure(errorMessage(error, "Pairing failed. Try a new code."));
      }
    })();
  }, [pair]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    try {
      await pair(code, deviceName);
    } catch (error) {
      setFailure(errorMessage(error, "Pairing failed. Try a new code."));
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-body px-4 py-6 sm:py-10">
      <Card width="100%" maxWidth={420} elevation="low" padding={6}>
        <form onSubmit={(event) => void submit(event)}>
          <VStack gap={5}>
            <VStack gap={3}>
              <BrandMark size={44} />
              <VStack gap={1}>
                <Heading level={1}>Link this phone</Heading>
                <Text color="secondary">
                  Scan the QR code in Nautilus on your PC, or enter the one-time code it shows. The
                  phone gets access to every project on this runner.
                </Text>
              </VStack>
            </VStack>
            <VStack gap={3}>
              <TextInput
                ref={codeRef}
                label="Pairing code"
                value={code}
                onChange={setCode}
                placeholder="4F7K-92QX"
                autoComplete="one-time-code"
                startIcon={KeyRound}
                size="lg"
                isRequired
              />
              <TextInput
                label="Device name"
                value={deviceName}
                onChange={setDeviceName}
                placeholder="Phone"
                autoComplete="off"
                size="lg"
              />
            </VStack>
            {failure ? (
              <Banner status="error" title="Pairing failed" description={failure} />
            ) : null}
            <Button
              type="submit"
              label={isPairing ? "Linking…" : "Link this phone"}
              variant="primary"
              size="lg"
              width="100%"
              isLoading={isPairing}
              isDisabled={!code.trim()}
            />
            <div className="flex items-center gap-2 text-secondary">
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              <Text type="supporting">One-time code · secure cookie session</Text>
            </div>
          </VStack>
        </form>
      </Card>
    </main>
  );
}
