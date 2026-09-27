import { expect, test } from "vitest";
import type { ProjectState } from "@nautilus/types";
import {
  isProjectReady,
  isProjectServing,
  projectNotReadyReason,
  projectStatus,
} from "@/lib/project";

test("a project is ready only once it has been pushed at least once", () => {
  expect(isProjectReady({ firstSyncAt: null })).toBe(false);
  expect(isProjectReady({ firstSyncAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
});

test("the not-ready reason names the project and the way out", () => {
  const reason = projectNotReadyReason({ name: "Shop" });
  expect(reason).toContain("Shop");
  expect(reason).toMatch(/push/i);
});

test("serving is still reported by state, and is a separate concern from readiness", () => {
  expect(isProjectServing("running")).toBe(true);
  expect(isProjectServing("inactive")).toBe(false);
});

const synced = "2026-01-01T00:00:00.000Z";

test.each<[ProjectState, { isServing: boolean; isRunning: boolean; canToggle: boolean }]>([
  ["inactive", { isServing: false, isRunning: false, canToggle: true }],
  ["starting", { isServing: false, isRunning: true, canToggle: true }],
  ["running", { isServing: true, isRunning: true, canToggle: true }],
  ["editing", { isServing: true, isRunning: true, canToggle: true }],
  ["checkpointing", { isServing: true, isRunning: true, canToggle: true }],
  ["idle", { isServing: true, isRunning: true, canToggle: true }],
  ["unhealthy", { isServing: false, isRunning: false, canToggle: false }],
  ["stopped", { isServing: false, isRunning: false, canToggle: true }],
  ["error", { isServing: false, isRunning: false, canToggle: true }],
])("a synced %s project", (state, expected) => {
  expect(projectStatus({ state, firstSyncAt: synced })).toMatchObject(expected);
});

test("a project without code never serves and cannot be started", () => {
  const status = projectStatus({ state: "running", firstSyncAt: null });
  expect(status.isReady).toBe(false);
  expect(status.isServing).toBe(false);
  expect(status.canToggle).toBe(false);
});

test("an unhealthy project needs recovery", () => {
  expect(projectStatus({ state: "unhealthy", firstSyncAt: synced }).needsRecovery).toBe(true);
});
