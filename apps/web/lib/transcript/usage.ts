import { record } from "../values";
import type { TranscriptItem } from "./items";

export type Usage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;

  cost: number;
};

export function usageOf(info: Record<string, unknown>): Usage | null {
  const tokens = record(info.tokens);
  const cache = record(tokens.cache);
  const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
  const usage: Usage = {
    input: count(tokens.input),
    output: count(tokens.output),
    reasoning: count(tokens.reasoning),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
    cost: count(info.cost),
  };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}

export function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (!next) return total;
  if (!total) return next;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    reasoning: total.reasoning + next.reasoning,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
  };
}

export function contextTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output + usage.reasoning;
}

export function latestUsage(items: readonly TranscriptItem[]): Usage | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "assistant" && item.usage) return item.usage;
  }
  return null;
}
