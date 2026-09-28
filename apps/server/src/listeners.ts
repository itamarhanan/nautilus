import { readFile, readdir, readlink } from "node:fs/promises";

export type Listener = {
  host: string;
  port: number;

  depth: number;
};

const LISTEN_STATE = "0A";

export function decodeAddress(hex: string): string {
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    for (const offset of [6, 4, 2, 0]) {
      bytes.push(parseInt(hex.slice(word + offset, word + offset + 2), 16));
    }
  }
  const mappedPrefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
  if (bytes.length === 16 && mappedPrefix.every((value, index) => bytes[index] === value)) {
    bytes.splice(0, 12);
  }
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  if (groups.every((group) => group === "0")) return "::";
  return groups.join(":").replace(/(^|:)(0:)+/, "::");
}

function dialHost(address: string): string {
  if (address === "0.0.0.0" || address === "::") return "127.0.0.1";
  if (address === "::1") return "[::1]";
  return address.includes(":") ? `[${address}]` : address;
}

async function listeningSockets(): Promise<Map<string, { host: string; port: number }>> {
  const sockets = new Map<string, { host: string; port: number }>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = await readFile(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
      const address = fields[1]?.split(":")[0];
      const port = fields[1]?.split(":")[1];
      const inode = fields[9];
      if (!address || !port || !inode) continue;
      sockets.set(inode, {
        host: dialHost(decodeAddress(address)),
        port: parseInt(port, 16),
      });
    }
  }
  return sockets;
}

async function processStat(
  pid: number,
): Promise<{ ppid: number; pgrp: number; session: number } | undefined> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");

    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3]) };
  } catch {
    return undefined;
  }
}

// A dev server starts in a session of its own, and everything it spawns stays
// in it, even what a task runner such as turbo moves into a process group of
// its own. Maps each member to its parent.
export async function sessionMembers(sessionId: number): Promise<Map<number, number>> {
  const members = new Map<number, number>();
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return members;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    const stat = await processStat(pid);
    if (stat?.session === sessionId) members.set(pid, stat.ppid);
  }
  return members;
}

export async function sessionListeners(sessionId: number): Promise<Listener[]> {
  const members = await sessionMembers(sessionId);
  if (members.size === 0) return [];
  const sockets = await listeningSockets();
  const found = new Map<string, Listener>();
  for (const pid of members.keys()) {
    let depth = 0;
    for (let parent = pid; parent !== sessionId && members.has(parent); depth += 1) {
      parent = members.get(parent) as number;
    }
    let fds: string[];
    try {
      fds = await readdir(`/proc/${String(pid)}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = await readlink(`/proc/${String(pid)}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      const socket = inode ? sockets.get(inode) : undefined;
      if (!socket) continue;
      const key = `${socket.host}:${String(socket.port)}`;
      const known = found.get(key);
      if (!known || depth < known.depth) found.set(key, { ...socket, depth });
    }
  }
  return [...found.values()];
}

export function pickListener(listeners: Listener[], assignedPort: number): Listener | undefined {
  const assigned = listeners.filter((listener) => listener.port === assignedPort);
  const candidates = assigned.length > 0 ? assigned : listeners;
  return [...candidates].sort(
    (a, b) =>
      a.depth - b.depth ||
      Number(b.host === "127.0.0.1") - Number(a.host === "127.0.0.1") ||
      a.port - b.port,
  )[0];
}
