import { useEffect, type ReactNode } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useApp } from "../context";
import type { Notice } from "../store";

const TONE_ICON: Record<Notice["tone"], ReactNode> = {
  success: <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />,
  warning: <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />,
  error: <XCircle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />,
  info: <Info className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />,
};

export function Notifier() {
  const notices = useApp((state) => state.notices);
  const dismissNotice = useApp((state) => state.dismissNotice);
  const toast = useToast();

  useEffect(() => {
    for (const notice of notices) {
      toast({
        type: notice.tone === "error" ? "error" : "info",
        isAutoHide: notice.tone !== "error" && notice.tone !== "warning",
        body: (
          <span className="flex items-start gap-2">
            {TONE_ICON[notice.tone]}
            <span className="flex min-w-0 flex-col">
              <span className="font-semibold">{notice.title}</span>
              {notice.body ? (
                <span className="select-text break-words text-secondary">{notice.body}</span>
              ) : null}
            </span>
          </span>
        ),
      });
      dismissNotice(notice.id);
    }
  }, [notices, toast, dismissNotice]);

  return null;
}
