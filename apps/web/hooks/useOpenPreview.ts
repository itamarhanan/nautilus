"use client";

import { useCallback } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { errorMessage } from "@/lib/api/client";
import { openInNewTab } from "@/lib/browser";
import { useActions } from "@/store";

export function useOpenPreview(): () => Promise<void> {
  const { previewUrl } = useActions();
  const toast = useToast();
  return useCallback(async () => {
    try {
      await openInNewTab(previewUrl);
    } catch (error) {
      toast({ body: errorMessage(error, "Unable to open preview"), type: "error" });
    }
  }, [previewUrl, toast]);
}
