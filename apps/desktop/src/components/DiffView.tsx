import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SyncDiff, SyncDiffHunk, SyncFileChange } from "@nautilus/types";
import { ensureHighlightStyles, tokenize, type TokenLine } from "@astryxdesign/core/CodeBlock";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { diffDisplay } from "../lib/diff";
import { ChevronDown, ChevronRight } from "lucide-react";

const STATUS_LABEL: Record<SyncFileChange["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

const openByDefault = 3;

const OMITTED_NOTE: Record<NonNullable<SyncFileChange["omitted"]>, string> = {
  generated: "Generated file. Its diff is not shown.",
  large: "This file changed too many lines to show here.",

  limit: "Not shown: this diff arrived incomplete. Restart the app to update the sync agent.",
};

const LANGUAGES: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
  html: "html",
  xml: "xml",
  svg: "svg",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  php: "php",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
};

function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

const fileKey = (file: SyncFileChange): string => `${file.status}:${file.path}`;

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

export function DiffView({ diff, highlight = [] }: { diff: SyncDiff; highlight?: string[] }) {
  const conflicted = useMemo(() => new Set(highlight), [highlight]);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        diff.files
          .slice(0, openByDefault)
          .filter((file) => diffDisplay(file).kind === "shown")
          .map(fileKey),
      ),
  );
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    const element = scroller ?? scrollParent(list);
    if (!list || !element) return;
    if (element !== scroller) setScroller(element);
    const next =
      list.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    if (Math.abs(next - offset) > 0.5) setOffset(next);
  });

  const virtualizer = useVirtualizer({
    count: diff.files.length,
    getScrollElement: () => scroller,
    estimateSize: () => 44,
    overscan: 8,
    scrollMargin: offset,
    getItemKey: (index) => {
      const file = diff.files[index];
      return file ? fileKey(file) : `missing-${String(index)}`;
    },
  });

  const onToggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const onLoad = useCallback((id: string) => {
    setLoaded((current) => new Set(current).add(id));
  }, []);

  if (diff.files.length === 0) return <Text type="supporting">No file changes.</Text>;
  return (
    <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const file = diff.files[item.index];
        if (!file) return null;
        const key = fileKey(file);
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full pb-2"
            style={{
              transform: `translateY(${String(item.start - offset)}px)`,
            }}
          >
            <FileDiff
              file={file}
              fileId={key}
              open={open.has(key)}
              loaded={loaded.has(key)}
              conflicted={conflicted.has(file.path)}
              onToggle={onToggle}
              onLoad={onLoad}
            />
          </div>
        );
      })}
    </div>
  );
}

const FileDiff = memo(function FileDiff({
  file,
  fileId,
  open,
  loaded,
  conflicted,
  onToggle,
  onLoad,
}: {
  file: SyncFileChange;
  fileId: string;
  open: boolean;
  loaded: boolean;
  conflicted: boolean;
  onToggle: (fileId: string) => void;
  onLoad: (fileId: string) => void;
}) {
  return (
    <div
      className={`overflow-hidden rounded-md border ${conflicted ? "border-warning" : "border-border"}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 bg-surface px-3 py-2 text-left text-xs leading-5 hover:bg-overlay-hover"
        aria-expanded={open}
        onClick={() => {
          onToggle(fileId);
        }}
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-secondary" aria-hidden />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-secondary" aria-hidden />
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono"
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className={`shrink-0 ${conflicted ? "text-warning" : "text-secondary"}`}>
          {conflicted ? "Conflict" : STATUS_LABEL[file.status]}
        </span>
        <span className="w-24 shrink-0 text-right font-mono tabular-nums">
          {file.binary ? (
            <span className="text-secondary">binary</span>
          ) : (
            <>
              <span className="text-success">+{String(file.additions)}</span>{" "}
              <span className="text-error">−{String(file.deletions)}</span>
            </>
          )}
        </span>
      </button>
      {open ? (
        <FileBody
          file={file}
          loaded={loaded}
          onLoad={() => {
            onLoad(fileId);
          }}
        />
      ) : null}
    </div>
  );
});

function FileBody({
  file,
  loaded,
  onLoad,
}: {
  file: SyncFileChange;
  loaded: boolean;
  onLoad: () => void;
}) {
  const display = useMemo(() => diffDisplay(file), [file]);
  const language = languageOf(file.path);
  if (display.kind === "omitted") return <DiffNote>{OMITTED_NOTE[display.reason]}</DiffNote>;
  if (display.kind === "binary")
    return <DiffNote>Binary file. Its contents are not shown.</DiffNote>;
  if (display.kind === "empty") return <DiffNote>No line changes.</DiffNote>;
  if (display.kind === "large" && !loaded) {
    return (
      <DiffNote
        action={<Button label="Load diff" size="sm" variant="secondary" onClick={onLoad} />}
      >
        {`Large diff (${display.changed.toLocaleString()} changed lines), hidden to keep the review fast.`}
      </DiffNote>
    );
  }
  return file.hunks.map((hunk, hunkIndex) => (
    <Hunk hunk={hunk} language={language} key={`${String(hunk.oldStart)}:${String(hunkIndex)}`} />
  ));
}

export function SingleFileDiff({ file }: { file: SyncFileChange }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <FileBody
      file={file}
      loaded={loaded}
      onLoad={() => {
        setLoaded(true);
      }}
    />
  );
}

function DiffNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2.5">
      <Text type="supporting">{children}</Text>
      {action}
    </div>
  );
}

function Hunk({ hunk, language }: { hunk: SyncDiffHunk; language: string | null }) {
  const tokens = useMemo(() => {
    if (language === null) return null;
    ensureHighlightStyles();
    return tokenize(hunk.lines.map((line) => line.content).join("\n"), language);
  }, [hunk, language]);
  return (
    <div className="select-text overflow-x-auto border-t border-border py-1 font-mono text-xs">
      <div className="px-3 py-0.5 text-secondary">
        {`@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`}
      </div>
      {hunk.lines.map((line, lineIndex) => (
        <pre
          className={`m-0 min-w-max whitespace-pre pr-3 ${
            line.type === "addition"
              ? "bg-success-muted"
              : line.type === "deletion"
                ? "bg-error-muted"
                : ""
          }`}
          key={`${String(line.oldLine ?? "x")}-${String(line.newLine ?? "x")}-${String(lineIndex)}`}
        >
          <span className="inline-block w-10 select-none pr-2 text-right text-secondary opacity-70">
            {line.type === "deletion" ? line.oldLine : line.newLine}
          </span>
          <span className="inline-block w-4 select-none text-secondary">
            {line.type === "addition" ? "+" : line.type === "deletion" ? "-" : " "}
          </span>
          {highlighted(line.content, tokens?.[lineIndex])}
        </pre>
      ))}
    </div>
  );
}

function highlighted(content: string, tokens: TokenLine | undefined): ReactNode {
  if (!tokens || tokens.length === 0) return content;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start < at || token.end <= token.start) continue;
    if (token.start > at) parts.push(content.slice(at, token.start));
    parts.push(
      <span key={token.start} style={{ color: `var(--color-syntax-${token.type})` }}>
        {content.slice(token.start, token.end)}
      </span>,
    );
    at = token.end;
  }
  if (at < content.length) parts.push(content.slice(at));
  return parts;
}
