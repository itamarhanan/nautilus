import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecoverySummary, RunnerLifecycleState } from "@nautilus/types";

type JournalEntry = {
  timestamp: string;
  state: RunnerLifecycleState;
  reason?: string;
};

type JournalEventType = "service_start" | "service_stop" | "session_interrupted" | "checkpoint";

type JournalEvent = {
  timestamp: string;
  type: JournalEventType;
  projectId?: string;
  service?: "server" | "web" | "gateway" | "opencode" | "dev-server";
  reason?: string;
  reference?: string;
};

export class LifecycleJournal {
  private state: RunnerLifecycleState = "stopped";
  private startedAt = new Date().toISOString();
  private updatedAt = this.startedAt;
  private recovered = false;
  private interruptedSessions = 0;
  private readonly degradedProjects = new Set<string>();
  private reason: string | null = null;

  constructor(private readonly path?: string) {}

  async initialize(): Promise<void> {
    if (!this.path) return;
    const previous = await readFile(this.path, "utf8").catch(() => "");
    this.recovered = previous.trim().length > 0;
  }

  async transition(state: RunnerLifecycleState, reason: string | null = null): Promise<void> {
    this.state = state;
    this.updatedAt = new Date().toISOString();
    this.reason = reason;
    if (!this.path) return;
    const entry: JournalEntry = {
      timestamp: this.updatedAt,
      state,
      ...(reason ? { reason } : {}),
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  recordDegradedProject(projectId: string): void {
    this.degradedProjects.add(projectId);
  }

  async clearDegradedProject(projectId: string): Promise<void> {
    if (!this.degradedProjects.delete(projectId)) return;
    if (this.state === "degraded" && this.degradedProjects.size === 0) {
      await this.transition("ready");
    }
  }

  async recordService(
    service: NonNullable<JournalEvent["service"]>,
    action: "start" | "stop",
  ): Promise<void> {
    await this.recordEvent({
      type: action === "start" ? "service_start" : "service_stop",
      service,
    });
  }

  async recordInterruptedSessions(count: number, projectId?: string): Promise<void> {
    this.interruptedSessions += count;
    await this.recordEvent({
      type: "session_interrupted",
      ...(projectId ? { projectId } : {}),
      reference: String(count),
    });
  }

  async recordCheckpoint(projectId: string, head: string): Promise<void> {
    await this.recordEvent({ type: "checkpoint", projectId, reference: head });
  }

  private async recordEvent(event: Omit<JournalEvent, "timestamp">): Promise<void> {
    if (!this.path) return;
    const entry: JournalEvent = { timestamp: new Date().toISOString(), ...event };
    await this.writeEntry(entry);
  }

  private async writeEntry(entry: JournalEvent): Promise<void> {
    await mkdir(dirname(this.path as string), { recursive: true, mode: 0o700 });
    await appendFile(this.path as string, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  snapshot(): RecoverySummary {
    return {
      state: this.state,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      recovered: this.recovered,
      interruptedSessions: this.interruptedSessions,
      degradedProjects: [...this.degradedProjects].sort(),
      reason: this.reason,
    };
  }
}
