export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogFormat = "json" | "pretty";

export type LoggerOptions = {
  format?: LogFormat;
  level?: LogLevel;
  color?: boolean;
};

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_STYLE: Record<LogLevel, { label: string; color: string }> = {
  debug: { label: "DBG", color: "\x1b[90m" },
  info: { label: "INF", color: "\x1b[36m" },
  warn: { label: "WRN", color: "\x1b[33m" },
  error: { label: "ERR", color: "\x1b[31m" },
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function isLogLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && value in LEVEL_RANK;
}

export function loggerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const format: LogFormat = env.NAUTILUS_LOG_FORMAT === "pretty" ? "pretty" : "json";
  const level = env.NAUTILUS_LOG_LEVEL?.toLowerCase();
  const color =
    env.NO_COLOR === undefined &&
    (env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : process.stdout.isTTY);
  return { format, level: isLogLevel(level) ? level : "debug", color };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/.test(value) || value === "" ? JSON.stringify(value) : value;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

export class Logger {
  private readonly format: LogFormat;
  private readonly minRank: number;
  private readonly color: boolean;

  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
    options: LoggerOptions = {},
  ) {
    this.format = options.format ?? "json";
    this.minRank = LEVEL_RANK[options.level ?? "debug"];
    this.color = options.color ?? false;
  }

  debug(event: string, fields: LogFields = {}): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.log("error", event, fields);
  }

  private log(level: LogLevel, event: string, fields: LogFields): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const timestamp = new Date().toISOString();
    if (this.format === "json") {
      this.write(JSON.stringify({ timestamp, level, event, ...fields }) + "\n");
      return;
    }
    this.write(this.pretty(timestamp, level, event, fields) + "\n");
  }

  private pretty(timestamp: string, level: LogLevel, event: string, fields: LogFields): string {
    const paint = (code: string, text: string) => (this.color ? `${code}${text}${RESET}` : text);
    const style = LEVEL_STYLE[level];
    const time = paint(DIM, timestamp.slice(11, 23));
    const label = paint(style.color + BOLD, style.label);
    const name = level === "debug" ? paint(DIM, event) : paint(BOLD, event);
    const pairs = Object.entries(fields)
      .map(([key, value]) => `${paint(DIM, `${key}=`)}${formatValue(value)}`)
      .join(" ");
    return pairs ? `${time} ${label} ${name} ${pairs}` : `${time} ${label} ${name}`;
  }
}
