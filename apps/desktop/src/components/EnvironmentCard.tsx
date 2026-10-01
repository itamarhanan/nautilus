import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Eye, EyeOff, FileDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useApp } from "../context";
import { foundVariables, type ScannedEnvFile } from "../lib/environment";
import { plural } from "../lib/format";
import { ImportEnvironmentDialog } from "../overlays/ImportEnvironmentDialog";

// A saved row keeps its value out of the UI: it can be replaced or removed,
// never shown again. Only a value typed or picked in this edit can be revealed.
type Row = {
  id: number;
  key: string;
  value: string;
  saved: boolean;
  replacing: boolean;
  visible: boolean;
};

export function EnvironmentCard({ projectId }: { projectId: string }) {
  const readEnvironment = useApp((state) => state.readEnvironment);
  const refreshEnvironment = useApp((state) => state.refreshEnvironment);
  const saveEnvironment = useApp((state) => state.saveEnvironment);
  const runner = useApp((state) => state.environments[projectId]);
  const connected = useApp((state) => state.connection.phase === "connected");

  const nextId = useRef(0);
  const savedValues = useRef<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [files, setFiles] = useState<ScannedEnvFile[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [keychain, setKeychain] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const stored = await readEnvironment(projectId);
      savedValues.current = stored.variables;
      setKeychain(stored.keychain);
      setFiles(stored.files);
      setScanError(stored.scanError);
      setRows(
        Object.keys(stored.variables)
          .sort()
          .map((key) => ({
            id: (nextId.current += 1),
            key,
            value: "",
            saved: true,
            replacing: false,
            visible: false,
          })),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, readEnvironment]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (connected) void refreshEnvironment(projectId);
  }, [connected, projectId, refreshEnvironment]);

  const variables = useMemo(() => {
    const result: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      result[key] = row.saved && !row.replacing ? (savedValues.current[row.key] ?? "") : row.value;
    }
    return result;
  }, [rows]);

  const dirty =
    rows.some((row) => !row.saved || row.replacing) ||
    rows.filter((row) => row.saved).length !== Object.keys(savedValues.current).length;

  const found = useMemo(
    () => foundVariables(files, new Set(rows.map((row) => row.key.trim()))),
    [files, rows],
  );

  const patch = (id: number, partial: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...partial } : row)));
  };

  const add = (...entries: { key: string; value: string }[]) => {
    setRows((current) => [
      ...current,
      ...entries.map(({ key, value }) => ({
        id: (nextId.current += 1),
        key,
        value,
        saved: false,
        replacing: false,
        visible: false,
      })),
    ]);
  };

  const save = async () => {
    if (!dirty || saving) return;
    const keys = rows.map((row) => row.key.trim()).filter(Boolean);
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate) {
      setError(`${duplicate} is listed twice.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const failure = await saveEnvironment(projectId, variables);
      setError(failure);
      if (!failure) await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <div className="flex flex-col gap-1">
          <Heading level={4} accessibilityLevel={2}>
            Environment variables
          </Heading>
          <Text type="supporting">
            The preview gets these instead of your env files, which never sync. They leave this PC
            and stay on the runner, so use preview-only credentials: test API keys and a dev
            database, not production secrets. The agent sees their names, never their values.
          </Text>
          <Text type="supporting">
            {runner === undefined ? (
              connected ? (
                "Checking the runner…"
              ) : (
                "Connect to the runner to see what it holds."
              )
            ) : runner === null ? (
              "This runner is too old to hold variables. Update it first."
            ) : runner.keys.length === 0 ? (
              "The runner holds no variables for this project."
            ) : (
              <>
                The runner holds {plural(runner.keys.length, "variable")}
                {runner.updatedAt ? (
                  <>
                    , updated <Timestamp value={runner.updatedAt} format="relative" />
                  </>
                ) : null}
                .
              </>
            )}
          </Text>
        </div>

        {!keychain ? (
          <Banner
            status="warning"
            title="The OS keychain is not available"
            description={`These are saved in ~/.nautilus/env/${projectId}.json, readable only by your user.`}
          />
        ) : null}

        {loading ? null : (
          <VStack gap={2}>
            {rows.length === 0 ? (
              <Text type="supporting">No variables yet.</Text>
            ) : (
              rows.map((row) => (
                <div key={row.id} className="flex items-end gap-2">
                  <div className="w-2/5 min-w-0">
                    <TextInput
                      label="Name"
                      isLabelHidden
                      placeholder="NAME"
                      value={row.key}
                      isReadOnly={row.saved}
                      autoComplete="off"
                      onChange={(key) => {
                        patch(row.id, { key });
                      }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    {row.saved && !row.replacing ? (
                      <TextInput
                        label={`Value of ${row.key}`}
                        isLabelHidden
                        type="password"
                        value="••••••••"
                        isReadOnly
                        onChange={() => undefined}
                      />
                    ) : (
                      <TextInput
                        label={`Value of ${row.key || "new variable"}`}
                        isLabelHidden
                        placeholder={row.replacing ? "New value" : "Value"}
                        type={row.visible ? "text" : "password"}
                        value={row.value}
                        autoComplete="off"
                        onChange={(value) => {
                          patch(row.id, { value });
                        }}
                        onEnter={() => void save()}
                      />
                    )}
                  </div>
                  {row.saved && !row.replacing ? (
                    <IconButton
                      label={`Rotate the value of ${row.key}`}
                      variant="ghost"
                      icon={<RefreshCw className="size-3.5" aria-hidden />}
                      onClick={() => {
                        patch(row.id, { replacing: true, value: "" });
                      }}
                    />
                  ) : (
                    <IconButton
                      label={row.visible ? "Hide value" : "Show value"}
                      variant="ghost"
                      icon={
                        row.visible ? (
                          <EyeOff className="size-3.5" aria-hidden />
                        ) : (
                          <Eye className="size-3.5" aria-hidden />
                        )
                      }
                      onClick={() => {
                        patch(row.id, { visible: !row.visible });
                      }}
                    />
                  )}
                  <IconButton
                    label={`Remove ${row.key || "variable"}`}
                    variant="ghost"
                    icon={<Trash2 className="size-3.5" aria-hidden />}
                    onClick={() => {
                      setRows((current) => current.filter((entry) => entry.id !== row.id));
                    }}
                  />
                </div>
              ))
            )}
            <HStack gap={2}>
              <Button
                label="Add variable"
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" aria-hidden />}
                onClick={() => {
                  add({ key: "", value: "" });
                }}
              />
              {found.length > 0 ? (
                <Button
                  label="Import from env files"
                  size="sm"
                  variant="ghost"
                  icon={<FileDown className="size-3.5" aria-hidden />}
                  onClick={() => {
                    setImporting(true);
                  }}
                />
              ) : null}
            </HStack>
          </VStack>
        )}

        {scanError ? (
          <Text type="supporting">Your env files could not be read: {scanError}</Text>
        ) : null}

        {error ? <Banner status="error" title="Could not save" description={error} /> : null}
        <div className="flex items-center justify-end gap-2">
          {dirty ? (
            <Button
              label="Discard"
              variant="ghost"
              isDisabled={saving}
              onClick={() => void load()}
            />
          ) : null}
          <Button
            label="Save"
            variant="primary"
            isLoading={saving}
            isDisabled={!dirty || loading}
            onClick={() => void save()}
          />
        </div>
      </VStack>
      <ImportEnvironmentDialog
        isOpen={importing}
        found={found}
        onImport={(entries) => {
          add(...entries.map(({ key, value }) => ({ key, value })));
        }}
        onClose={() => {
          setImporting(false);
        }}
      />
    </Card>
  );
}
