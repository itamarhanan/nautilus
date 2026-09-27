import { describe, expect, it } from "vitest";
import { Logger, loggerOptionsFromEnv } from "../src/logger";

function capture(options: ConstructorParameters<typeof Logger>[1]) {
  const lines: string[] = [];
  return { lines, logger: new Logger((line) => lines.push(line), options) };
}

describe("Logger", () => {
  it("writes JSON lines by default", () => {
    const { lines, logger } = capture(undefined);
    logger.info("server_started", { port: 4001 });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "info",
      event: "server_started",
      port: 4001,
    });
  });

  it("formats pretty lines and drops events below the minimum level", () => {
    const { lines, logger } = capture({ format: "pretty", level: "info", color: false });
    logger.debug("noisy_event");
    logger.warn("opencode_stderr", { output: "port in use", code: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3} WRN opencode_stderr output="port in use" code=1\n$/,
    );
  });

  it("reads format, level, and color from the environment", () => {
    expect(
      loggerOptionsFromEnv({
        NAUTILUS_LOG_FORMAT: "pretty",
        NAUTILUS_LOG_LEVEL: "WARN",
        NO_COLOR: "1",
      }),
    ).toEqual({ format: "pretty", level: "warn", color: false });
    expect(loggerOptionsFromEnv({ NAUTILUS_LOG_LEVEL: "bogus" })).toMatchObject({
      format: "json",
      level: "debug",
    });
  });
});
