import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadOrCreateSecret(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 32) return existing;
    throw new Error(`secret at ${path} is shorter than 32 characters`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(48).toString("base64url");
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${secret}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateSecret(path);
    throw error;
  }
}
