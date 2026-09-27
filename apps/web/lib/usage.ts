import type { Usage } from "./transcript";

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${String(Math.round(tokens / 1_000))}K`;
  return `${String(Math.round(tokens / 100_000) / 10)}M`;
}

export function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01";
}

export function usageSummary(usage: Usage): string {
  const written = formatTokens(usage.output + usage.reasoning);
  return usage.cost > 0 ? `${written} tokens · ${formatCost(usage.cost)}` : `${written} tokens`;
}
