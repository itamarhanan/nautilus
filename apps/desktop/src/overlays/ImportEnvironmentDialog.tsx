import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { FoundVariable } from "../lib/environment";
import { plural } from "../lib/format";

// Picks which keys from the project's env files become variables. Importing
// only fills the form; nothing leaves the PC until the form is saved.
export function ImportEnvironmentDialog({
  isOpen,
  found,
  onImport,
  onClose,
}: {
  isOpen: boolean;
  found: FoundVariable[];
  onImport: (entries: FoundVariable[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);

  // Each opening starts from the keys the dev command reads.
  useEffect(() => {
    if (isOpen) setSelected(found.filter((entry) => entry.importable).map((entry) => entry.key));
  }, [isOpen, found]);

  const chosen = found.filter((entry) => selected.includes(entry.key));
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="form"
      width={520}
    >
      <Layout
        height="auto"
        header={<DialogHeader title="Import from env files" onOpenChange={onClose} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text type="body" color="secondary">
                Each key takes its value from the file your dev server reads it from. Production and
                test files start unticked. Swap any real secret for a preview one before saving.
              </Text>
              {/* The dialog stops at 75% of the window, so the list gives up what
                  the header, text and buttons need rather than pushing them out. */}
              <div className="max-h-[min(20rem,calc(75dvh_-_16rem))] min-h-24 overflow-y-auto">
                <CheckboxList
                  label="Variables to import"
                  isLabelHidden
                  value={selected}
                  onChange={setSelected}
                  density="compact"
                >
                  {found.map((entry) => (
                    <CheckboxListItem
                      key={entry.key}
                      value={entry.key}
                      label={<Text type="code">{entry.key}</Text>}
                      aria-label={entry.key}
                      description={
                        entry.importable
                          ? entry.path
                          : `${entry.path} · not read by the dev command`
                      }
                    />
                  ))}
                </CheckboxList>
              </div>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
              <Button
                label={chosen.length > 0 ? `Import ${plural(chosen.length, "variable")}` : "Import"}
                variant="primary"
                isDisabled={chosen.length === 0}
                onClick={() => {
                  onImport(chosen);
                  onClose();
                }}
                data-autofocus
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
