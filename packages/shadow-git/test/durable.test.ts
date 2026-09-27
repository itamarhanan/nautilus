import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LockBusyError, readJson, withLock, writeJson } from "../src/durable";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nautilus-lock-test-"));
  roots.push(root);
  return join(root, "state", "demo.lock");
}

const deadPid = 2 ** 22 + 7;

describe("withLock", () => {
  test("holds the lock for the action and releases it afterwards, even on failure", async () => {
    const path = await lockPath();
    await withLock(path, async () => {
      await expect(withLock(path, () => Promise.resolve())).rejects.toBeInstanceOf(LockBusyError);
    });
    await expect(withLock(path, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock(path, () => Promise.resolve("free"))).toBe("free");
  });

  test("reclaims a lock left by a process that has exited", async () => {
    const path = await lockPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid: deadPid,
        instance: "gone",
        acquiredAt: new Date().toISOString(),
      }),
    );
    expect(await withLock(path, () => Promise.resolve("ran"))).toBe("ran");
  });

  test("reclaims the directory locks older builds left behind", async () => {
    const path = await lockPath();
    await mkdir(path, { recursive: true });
    expect(await withLock(path, () => Promise.resolve("ran"))).toBe("ran");
  });

  test("respects a lock held by another live process", async () => {
    const path = await lockPath();
    await mkdir(join(path, ".."), { recursive: true });

    await writeFile(
      path,
      JSON.stringify({
        pid: process.ppid,
        instance: "other",
        acquiredAt: new Date().toISOString(),
      }),
    );
    await expect(withLock(path, () => Promise.resolve())).rejects.toBeInstanceOf(LockBusyError);
  });

  test("reclaims a live owner's lock once it is older than any sync could take", async () => {
    const path = await lockPath();
    await mkdir(join(path, ".."), { recursive: true });
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await writeFile(
      path,
      JSON.stringify({
        pid: process.ppid,
        instance: "other",
        acquiredAt: hourAgo,
      }),
    );
    expect(await withLock(path, () => Promise.resolve("ran"))).toBe("ran");
  });
});

describe("readJson and writeJson", () => {
  test("round-trips a value and falls back when the file is missing or corrupt", async () => {
    const path = join(await lockPath(), "..", "value.json");
    expect(await readJson(path, "fallback")).toBe("fallback");
    await writeJson(path, { head: "abc" });
    expect(await readJson(path, null)).toEqual({ head: "abc" });
    await writeFile(path, "{ not json");
    expect(await readJson(path, "fallback")).toBe("fallback");
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});
