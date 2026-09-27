import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, usageSummary } from "@/lib/usage";

describe("usage formatting", () => {
  it("shortens token counts and keeps cheap turns from reading as free", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12K");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.237)).toBe("$0.24");
  });

  it("shows cost only when the provider charged", () => {
    const usage = {
      input: 9000,
      output: 1500,
      reasoning: 500,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    expect(usageSummary(usage)).toBe("2K tokens");
    expect(usageSummary({ ...usage, cost: 0.05 })).toBe("2K tokens · $0.05");
  });
});
